import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

let userCounter = 0;
function freshUser() {
  const stub = env.TEST_USER.getByName(`user-push-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  return <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
}

// A real browser key pair's public half and a 16-byte secret (RFC 8291 Appendix A).
const KEYS = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const IPHONE = { endpoint: "https://web.push.apple.com/iphone", ...KEYS };
const LAPTOP = { endpoint: "https://fcm.googleapis.com/fcm/send/laptop", ...KEYS };
const NOTIFICATION = { title: "Done · Trip", body: "Booked.", url: "https://workshop.example/workspace/w", tag: "t" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UserDurableObject push notifications", () => {
  it("creates one VAPID key for the user and keeps it", async () => {
    const inDo = freshUser();
    const key = await inDo(u => u.getPushPublicKey());
    expect(key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(await inDo(u => u.getPushPublicKey())).toBe(key);
  });

  it("refuses endpoints outside the known push services and malformed keys", async () => {
    const inDo = freshUser();
    await expect(inDo(u => u.addPushSubscription({ ...IPHONE, endpoint: "https://internal.example/x" })))
        .rejects.toThrow(/not a known push service/);
    await expect(inDo(u => u.addPushSubscription({ ...IPHONE, p256dh: "AAAA" })))
        .rejects.toThrow(/Not a valid push subscription/);
    await expect(inDo(u => u.addPushSubscription({ ...IPHONE, auth: "AAAA" })))
        .rejects.toThrow(/Not a valid push subscription/);
    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(0);
  });

  it("delivers to every subscribed device, signed and encrypted, and forgets the gone ones", async () => {
    const inDo = freshUser();
    await inDo(u => u.addPushSubscription(IPHONE));
    await inDo(u => u.addPushSubscription(LAPTOP));
    const key = await inDo(u => u.getPushPublicKey());

    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      // The laptop's browser has dropped its subscription.
      return new Response(null, { status: request.url === LAPTOP.endpoint ? 410 : 201 });
    });

    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(1);
    expect(seen.map(r => r.url).toSorted()).toEqual([LAPTOP.endpoint, IPHONE.endpoint].toSorted());
    for (const request of seen) {
      expect(request.headers.get("Authorization")).toContain(`k=${key}`);
      expect(request.headers.get("Content-Encoding")).toBe("aes128gcm");
    }

    seen.length = 0;
    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(1);
    expect(seen.map(r => r.url)).toEqual([IPHONE.endpoint]);
  });

  it("keeps a device through a transient failure, and stops on removal", async () => {
    const inDo = freshUser();
    await inDo(u => u.addPushSubscription(IPHONE));
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(null, { status: 503 });
    });
    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(0);
    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(0);
    expect(calls).toBe(2);

    await inDo(u => u.removePushSubscription(IPHONE.endpoint));
    expect(await inDo(u => u.notify(NOTIFICATION))).toBe(0);
    expect(calls).toBe(2);
  });

  it("sends a test notification that opens the profile page", async () => {
    const inDo = freshUser();
    await inDo(u => u.addPushSubscription(IPHONE));
    vi.stubGlobal("fetch", async () => new Response(null, { status: 201 }));
    expect(await inDo(u => u.sendTestNotification())).toBe(1);
  });
});
