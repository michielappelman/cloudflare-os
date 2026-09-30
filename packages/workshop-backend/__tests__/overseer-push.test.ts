// Push notifications a workspace sends its owner: an action waiting for approval, unless the owner
// is looking at the workspace. Runs a real OverseerDurableObject whose owner is a real user DO
// with one subscribed device; the push service is a stubbed fetch, and each message is decrypted
// with that device's private key to check what the owner would see.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { base64UrlDecode, base64UrlEncode } from "../src/web-push.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// The device: RFC 8291 Appendix A's user agent key pair and authentication secret.
const DEVICE = {
  endpoint: "https://web.push.apple.com/device",
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  privateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: infoBytes }, key, bytes * 8));
}

function point(raw: Uint8Array) {
  return {
    kty: "EC", crv: "P-256",
    x: base64UrlEncode(raw.subarray(1, 33)), y: base64UrlEncode(raw.subarray(33)),
  };
}

// Decrypts an aes128gcm push body as the device would (RFC 8291 section 3.4, receiving side).
async function decrypt(body: Uint8Array): Promise<any> {
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body[20]);
  const ciphertext = body.subarray(21 + body[20]);
  const uaPublic = base64UrlDecode(DEVICE.p256dh);
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const ours = await crypto.subtle.importKey(
      "jwk", { ...point(uaPublic), d: DEVICE.privateKey }, ecdh, false, ["deriveBits"]);
  const theirs = await crypto.subtle.importKey("jwk", point(senderPublic), ecdh, false, []);
  const params = { name: "ECDH", public: theirs };
  const secret = new Uint8Array(await crypto.subtle.deriveBits(params, ours, 256));
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...uaPublic, ...senderPublic]);
  const ikm = await hkdf(base64UrlDecode(DEVICE.auth), secret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
  expect(record.at(-1)).toBe(2);
  return JSON.parse(new TextDecoder().decode(record.subarray(0, -1)));
}

const BOOK: ActionDescription = {
  title: "Send data to tebi.co",
  description: "The page wants to send text that was typed into it.",
  implementsRevert: false,
  awaitDecision: true,
};

function getImpl(instance: OverseerDurableObject): any {
  return (instance as unknown as { impl: any }).impl;
}

let counter = 0;

// A workspace owned by a user with DEVICE subscribed, and a push service recording deliveries.
async function setup() {
  const n = ++counter;
  const user = env.TEST_USER.getByName(`overseer-push-owner-${n}`);
  await runInDurableObject(user, u => u.addPushSubscription(DEVICE));
  const delivered: Uint8Array[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === DEVICE.endpoint) delivered.push(new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 201 });
  });
  const overseer = env.TEST_OVERSEER.getByName(`overseer-push-${n}`);
  const workspaceId = await runInDurableObject(overseer, async (instance: OverseerDurableObject) => {
    const impl = getImpl(instance);
    impl.ownerId = user.id.toString();
    impl.storage.title.put("Dinner plans");
    impl.storage.gatekeepers.put({
      id: 1, resourceTitle: "Web Browser", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "browser", resourceUrl: "browser://web", typeUrlPattern: "browser://*" },
    });
    return instance.ctx.id.toString();
  });
  return { overseer, workspaceId, delivered };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner push notifications", () => {
  it("tells the owner an agent's action is waiting, linking to its chat", async () => {
    const { overseer, workspaceId, delivered } = await setup();
    await runInDurableObject(overseer, (instance: OverseerDurableObject) =>
        getImpl(instance).submitAction(1, 0, BOOK, { from: "agent", chatId: 3 }));

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const message = await decrypt(delivered[0]);
    expect(message).toEqual({
      web_push: 8030,
      notification: {
        title: "Approval needed · Dinner plans",
        body: "Send data to tebi.co",
        navigate: `https://workshop.example/workspace/${workspaceId}?chat=3`,
        tag: expect.stringContaining(workspaceId),
      },
    });
  });

  it("stays quiet while the owner has the workspace open", async () => {
    const { overseer, delivered } = await setup();
    await runInDurableObject(overseer, async (instance: OverseerDurableObject) => {
      const impl = getImpl(instance);
      impl.ownerProfileId = "owner@example.com";
      impl.joinPresence("owner@example.com", { type: "user", id: "owner@example.com", name: "Owner" }, "build");
      await impl.submitAction(1, 0, BOOK, { from: "agent", chatId: 3 });
      // A collaborator viewing does not count as the owner seeing it.
      impl.joinPresence("guest@example.com", { type: "user", id: "guest@example.com", name: "Guest" }, "build");
    });
    // Give a (wrongly) queued delivery the chance to land before asserting none did.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivered).toHaveLength(0);
  });
});
