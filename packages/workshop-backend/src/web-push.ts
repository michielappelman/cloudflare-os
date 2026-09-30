// Web Push delivery (RFC 8030) with message encryption (RFC 8291) and VAPID sender
// identification (RFC 8292), on WebCrypto alone so it runs in Workers.
//
// Payloads are Declarative Web Push messages (`"web_push": 8030`): Safari shows them without
// running a service worker, which is the only reliable way on iOS; other browsers hand the same
// JSON to the service worker's `push` handler.

/** The subset of a browser `PushSubscription` needed to deliver to it. */
export type WebPushTarget = {
  endpoint: string;
  /** The user agent's P-256 public key, base64url (65-byte uncompressed point). */
  p256dh: string;
  /** The user agent's 16-byte authentication secret, base64url. */
  auth: string;
};

/** A VAPID key pair, as stored: the public key in the form browsers take as applicationServerKey. */
export type VapidKeys = {
  /** base64url of the 65-byte uncompressed P-256 point. */
  publicKey: string;
  privateKey: JsonWebKey;
};

/** What a notification shows, and where tapping it goes. */
export type PushNotification = {
  title: string;
  body: string;
  /** Absolute URL opened when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
  /** Sets the app icon badge where supported (Home Screen web apps). */
  badge?: number;
};

/**
 * Push services this deployment delivers to. The endpoint comes from the browser, so without this
 * a signed-in user could point the Worker's requests at any URL.
 */
const PUSH_SERVICE_HOSTS = [
  "web.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  ".notify.windows.com",
];

/** Throws unless `endpoint` is an https URL on a known push service. */
export function checkPushEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Push endpoint is not a URL.");
  }
  let host = url.hostname.toLowerCase();
  let known = PUSH_SERVICE_HOSTS.some(allowed =>
      allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed);
  if (url.protocol !== "https:" || !known) {
    throw new Error(`Push endpoint ${url.origin} is not a known push service.`);
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  let base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (let part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number)
    : Promise<Uint8Array> {
  let key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** A P-256 public key from its 65-byte uncompressed form. */
function publicJwk(point: Uint8Array): JsonWebKey {
  if (point.length !== 65 || point[0] !== 4) throw new Error("Not an uncompressed P-256 point.");
  return {
    kty: "EC", crv: "P-256", ext: true,
    x: base64UrlEncode(point.subarray(1, 33)), y: base64UrlEncode(point.subarray(33)),
  };
}

async function rawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key) as ArrayBuffer);
}

/** Generates a VAPID key pair for a new sender. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  let pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    publicKey: base64UrlEncode(await rawPublicKey(pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey,
  };
}

/**
 * Encrypts `plaintext` for one subscription as an aes128gcm body (RFC 8291 section 3.4): a single
 * record, keyed from an ECDH exchange between a fresh sender key pair and the user agent's key,
 * mixed with its authentication secret. `sender` and `salt` exist for the RFC's test vector;
 * callers leave them out.
 */
export async function encryptPushPayload(
    plaintext: Uint8Array, target: Pick<WebPushTarget, "p256dh" | "auth">,
    options: { sender?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  let uaPublic = base64UrlDecode(target.p256dh);
  let authSecret = base64UrlDecode(target.auth);
  let sender = options.sender ?? await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  let salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic = await rawPublicKey(sender.publicKey);

  let uaKey = await crypto.subtle.importKey(
      "jwk", publicJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  // A variable, not a literal: workers-types spells this member `$public`, but the runtime takes
  // the standard `public` (the RFC 8291 test vector in web-push.test.ts runs in workerd).
  let ecdhParams = { name: "ECDH", public: uaKey };
  let ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
      ecdhParams, sender.privateKey, 256));

  let keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  let ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  let cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  let nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // One record, so it is the last one: the 0x02 delimiter, no further padding.
  let record = concat(plaintext, new Uint8Array([2]));
  let aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  let ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt, record size (uint32), key id length, key id (the sender's public key).
  let recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * A VAPID `Authorization` header value (RFC 8292): an ES256 JWT for the push service's origin,
 * valid for 12 hours, naming `subject` as the sender's contact.
 */
export async function vapidAuthorization(
    endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  let header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  let claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  let signingKey = await crypto.subtle.importKey(
      "jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA output is already the raw r||s form JWS uses.
  let signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** The Declarative Web Push message for `notification`. */
export function declarativePayload(notification: PushNotification): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: notification.title,
      body: notification.body,
      navigate: notification.url,
      ...(notification.tag !== undefined ? { tag: notification.tag } : {}),
    },
    ...(notification.badge !== undefined ? { app_badge: notification.badge } : {}),
  });
}

/**
 * The outcome of one delivery. `gone` means the subscription no longer exists (404/410) and should
 * be forgotten; `failed` is anything else unsuccessful, including a network error.
 */
export type PushResult = { outcome: "sent" | "gone" | "failed"; status?: number };

/** Delivers `notification` to one subscription. Never throws. */
export async function sendPushNotification(
    target: WebPushTarget, notification: PushNotification, keys: VapidKeys, subject: string,
    fetcher: typeof fetch = fetch): Promise<PushResult> {
  try {
    checkPushEndpoint(target.endpoint);
    let body = await encryptPushPayload(encoder.encode(declarativePayload(notification)), target);
    let response = await fetcher(target.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthorization(target.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // A day: a notification about a finished task is still worth seeing tomorrow morning.
        "TTL": String(24 * 60 * 60),
        "Urgency": "high",
      },
      body,
    });
    await response.body?.cancel();
    if (response.ok) return { outcome: "sent", status: response.status };
    if (response.status === 404 || response.status === 410) {
      return { outcome: "gone", status: response.status };
    }
    return { outcome: "failed", status: response.status };
  } catch {
    return { outcome: "failed" };
  }
}
