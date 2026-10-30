// Keeps credentials Cloudflare returns out of what the caller sees and what approvals store.
//
// Some responses carry secrets as ordinary fields: an identity provider's `client_secret`, a
// Turnstile widget's `secret`, a newly created API token's `value`. A caller that could read them
// could act outside every binding, so they are replaced wherever they appear. Operations whose
// whole answer is a credential are blocked outright (see `api-tiers.ts`).

import type { ApiOperation } from "./api-spec.js";

/** What a removed value is replaced with. */
export const REDACTED = "[redacted by Cloudflare OS]";

/** Field names that hold a secret in every product that uses them. */
const SECRET_KEYS = new Set([
  "client_secret",
  "jwt",
  "password",
  "private_key",
  "secret",
  "secret_access_key",
  "session_token",
  "token",
]);

/** Commands whose `value` field (or whole string result) is a freshly minted credential. */
const VALUE_IS_SECRET_PREFIXES = [
  "accounts.tokens",
  "ai-search.tokens",
  "artifacts.namespaces.tokens",
  "builds.tokens",
  "user.tokens",
];

const MAX_DEPTH = 64;

function valueIsSecret(operation: ApiOperation): boolean {
  const command = operation.command ?? "";
  return VALUE_IS_SECRET_PREFIXES.some(prefix => command === prefix || command.startsWith(`${prefix}.`));
}

function walk(value: unknown, extraKeys: ReadonlySet<string>, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map(item => walk(item, extraKeys, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const lower = key.toLowerCase();
    out[key] = (SECRET_KEYS.has(lower) || extraKeys.has(lower)) && inner !== null && inner !== ""
      ? REDACTED
      : walk(inner, extraKeys, depth + 1);
  }
  return out;
}

/** Returns `result` with every secret-bearing field replaced. */
export function redactResult(operation: ApiOperation, result: unknown): unknown {
  const secretValue = valueIsSecret(operation);
  if (secretValue && typeof result === "string") return REDACTED;
  return walk(result, secretValue ? new Set(["value"]) : new Set(), 0);
}
