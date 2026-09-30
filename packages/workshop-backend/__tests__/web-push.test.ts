import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  checkPushEndpoint,
  declarativePayload,
  encryptPushPayload,
  generateVapidKeys,
  sendPushNotification,
  vapidAuthorization,
} from "../src/web-push";

// RFC 8291 Appendix A. The expected body was also reproduced with the http_ece reference
// implementation from these inputs.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function importRfcSender(): Promise<CryptoKeyPair> {
  let point = base64UrlDecode(RFC.asPublic);
  let jwk = {
    kty: "EC", crv: "P-256",
    x: base64UrlEncode(point.subarray(1, 33)), y: base64UrlEncode(point.subarray(33)),
  };
  let algorithm = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey(
        "jwk", { ...jwk, d: RFC.asPrivate }, algorithm, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, algorithm, true, []),
  };
}

const APPLE_ENDPOINT = "https://web.push.apple.com/QGuQyavXutnMbgDhe8B-2uEbq7jiHa6nTSpMYlAMWsovXkK";

describe("encryptPushPayload", () => {
  it("reproduces the RFC 8291 test vector", async () => {
    let body = await encryptPushPayload(
        new TextEncoder().encode(RFC.plaintext),
        { p256dh: RFC.uaPublic, auth: RFC.authSecret },
        { sender: await importRfcSender(), salt: base64UrlDecode(RFC.salt) });
    expect(base64UrlEncode(body)).toBe(RFC.body);
  });

  it("uses a fresh sender key and salt for every message", async () => {
    let target = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
    let plaintext = new TextEncoder().encode("same");
    let [a, b] = await Promise.all([encryptPushPayload(plaintext, target), encryptPushPayload(plaintext, target)]);
    expect(base64UrlEncode(a.subarray(0, 16))).not.toBe(base64UrlEncode(b.subarray(0, 16)));
    expect(base64UrlEncode(a.subarray(21, 86))).not.toBe(base64UrlEncode(b.subarray(21, 86)));
  });
});

describe("vapidAuthorization", () => {
  it("signs an ES256 token for the push service's origin that verifies with the public key", async () => {
    let keys = await generateVapidKeys();
    let now = Date.UTC(2026, 8, 30, 12);
    let header = await vapidAuthorization(APPLE_ENDPOINT, keys, "https://os.example.com", now);

    let match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(match).not.toBeNull();
    let [, head, claims, signature, k] = match;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(claims)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "https://os.example.com",
    });

    let publicKey = await crypto.subtle.importKey(
        "raw", base64UrlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, base64UrlDecode(signature),
        new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  });
});

describe("checkPushEndpoint", () => {
  it("accepts the major push services", () => {
    for (let endpoint of [
      APPLE_ENDPOINT,
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(() => checkPushEndpoint(endpoint)).not.toThrow();
    }
  });

  it("refuses anything else, so the Worker can't be aimed at arbitrary URLs", () => {
    for (let endpoint of [
      "http://web.push.apple.com/x",
      "https://web.push.apple.com.evil.example/x",
      "https://evilnotify.windows.com.example/x",
      "https://internal.example/admin",
      "not a url",
    ]) {
      expect(() => checkPushEndpoint(endpoint)).toThrow();
    }
  });
});

describe("declarativePayload", () => {
  it("is a Declarative Web Push message", () => {
    expect(JSON.parse(declarativePayload({
      title: "Approval needed", body: "Send data to tebi.co", url: "https://os.example.com/workspace/w?chat=3",
      tag: "approval-7", badge: 2,
    }))).toEqual({
      web_push: 8030,
      notification: {
        title: "Approval needed", body: "Send data to tebi.co",
        navigate: "https://os.example.com/workspace/w?chat=3", tag: "approval-7",
      },
      app_badge: 2,
    });
  });
});

describe("sendPushNotification", () => {
  const target = { endpoint: APPLE_ENDPOINT, p256dh: RFC.uaPublic, auth: RFC.authSecret };
  const notification = { title: "Done", body: "Workspace", url: "https://os.example.com/" };

  it("posts an encrypted, VAPID-signed message", async () => {
    let keys = await generateVapidKeys();
    let seen: Request | undefined;
    let result = await sendPushNotification(target, notification, keys, "https://os.example.com",
        async (input, init) => {
          seen = new Request(input, init);
          return new Response(null, { status: 201 });
        });
    expect(result).toEqual({ outcome: "sent", status: 201 });
    expect(seen!.url).toBe(APPLE_ENDPOINT);
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(seen!.headers.get("Authorization")).toMatch(/^vapid t=.+, k=/);
    expect(Number(seen!.headers.get("TTL"))).toBeGreaterThan(0);
    // Header (16 + 4 + 1 + 65) plus at least the 16-byte tag: never the plaintext.
    let body = new Uint8Array(await seen!.arrayBuffer());
    expect(body.length).toBeGreaterThan(102);
    expect(new TextDecoder().decode(body)).not.toContain("Done");
  });

  it("reports a subscription the push service no longer knows as gone", async () => {
    let keys = await generateVapidKeys();
    for (let status of [404, 410]) {
      let result = await sendPushNotification(target, notification, keys, "https://os.example.com",
          async () => new Response(null, { status }));
      expect(result).toEqual({ outcome: "gone", status });
    }
  });

  it("reports other failures without throwing, and never contacts an unknown host", async () => {
    let keys = await generateVapidKeys();
    expect(await sendPushNotification(target, notification, keys, "https://os.example.com",
        async () => new Response(null, { status: 429 }))).toEqual({ outcome: "failed", status: 429 });
    expect(await sendPushNotification(target, notification, keys, "https://os.example.com",
        async () => { throw new Error("network down"); })).toEqual({ outcome: "failed" });

    let called = false;
    expect(await sendPushNotification({ ...target, endpoint: "https://internal.example/x" },
        notification, keys, "https://os.example.com",
        async () => { called = true; return new Response(null, { status: 201 }); }))
        .toEqual({ outcome: "failed" });
    expect(called).toBe(false);
  });
});
