// How each Cloudflare API operation is governed. The tier is derived from the operation, never
// from the caller, and decides three things: whether a call is an observation or an approval-gated
// action, whether its action kind may be auto-approved, and whether it is reachable at all.
//
// The rules are deliberately few and fail closed: a GET is a read, anything else is a change, and
// a short reviewed list moves operations out of those defaults. An operation the lists do not name
// keeps the stricter default.

import type { ApiOperation } from "./api-spec.js";

/**
 * - `read`: returns data, changes nothing. Recorded as an observation.
 * - `write`: an ordinary change. Approval-gated; may be auto-approved per product.
 * - `destructive`: deletes, or Cloudflare's own CLI asks for confirmation. Always a person.
 * - `privileged`: identity, credentials, membership or billing. Always a person.
 * - `blocked`: hands the caller a live credential. Never callable.
 */
export type ApiTier = "read" | "write" | "destructive" | "privileged" | "blocked";

/**
 * POSTs that only read. Each was checked against the API reference: they run a query or validate
 * input and store nothing. `d1.query` is absent on purpose -- its SQL may write.
 */
const READ_ONLY_POSTS = new Set([
  "accounts.applications.lookup",
  "ai-audit.robots.bulk-get",
  "analytics-engine.sql.query",
  "analytics.query.data-security.findings.summary",
  "analytics.query.data-security.findings.timeseries",
  "analytics.query.summary",
  "analytics.query.timeseries",
  "api-security.token-validation.rules.preview",
  "billing.usage.query",
  "browser-extension.config.logs.extension-events.search",
  "browser-extension.config.logs.extension-events.timeseries",
  "cloudforce-one.stakeout.items.search",
  "cloudforce-one.threat-intel.events.search",
  "cloudforce-one.threat-intel.search",
  "email-sending.subdomains.preview",
  "kv.bulk.get",
  "logpush.transformers.preview",
  "logs.query",
  "logs.zone.query",
  "observability.telemetry.keys",
  "observability.telemetry.query",
  "observability.telemetry.values",
  "registrar.registrations.check",
  "vectorize.query",
  "waiting-rooms.page.preview",
  "zero-trust.access.custom-pages.validate",
  "zero-trust.dlp.patterns.validate",
]);

/**
 * Command prefixes whose changes act on identity, credentials, membership or money. A change here
 * is never auto-approved, and GETs stay reads.
 */
const PRIVILEGED_PREFIXES = [
  "accounts.create",
  "accounts.delete",
  "accounts.update",
  "accounts.members",
  "accounts.roles",
  "accounts.subscriptions",
  "accounts.tokens",
  "accounts.billing",
  "accounts.ut-billing",
  "ai-gateway.billing",
  "billing",
  "iam",
  "registrar",
  "user",
  "zero-trust.access.service-tokens",
  "zero-trust.identity-providers",
  "zero-trust.access.zone-organizations",
  "zero-trust.organization",
  "zones.subscriptions",
];

/**
 * Operations whose response *is* a live credential: a tunnel's run token, temporary R2 keys, a
 * Pages upload token. Redaction would leave them pointless and returning them would hand the
 * caller a secret, so they are refused.
 */
const BLOCKED_COMMANDS = new Set([
  "mesh.nodes.token.get",
  "pages.upload-token.get",
  "r2.temporary-credentials.create",
  "tunnels.token.get",
]);

function hasPrefix(command: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => command === prefix || command.startsWith(`${prefix}.`));
}

/** Classifies an operation. */
export function tierOf(operation: ApiOperation): ApiTier {
  const command = operation.command ?? "";
  if (BLOCKED_COMMANDS.has(command)) return "blocked";
  if (operation.method === "GET") return "read";
  if (operation.method === "POST" && READ_ONLY_POSTS.has(command)) return "read";
  if (hasPrefix(command || operation.product, PRIVILEGED_PREFIXES)) return "privileged";
  if (operation.method === "DELETE" || operation.confirm) return "destructive";
  return "write";
}

/** Whether calling the operation queues an approval rather than returning data. */
export function isAction(tier: ApiTier): boolean {
  return tier === "write" || tier === "destructive" || tier === "privileged";
}

/** The auto-approval tag for ordinary changes to one product. */
export function actionKindTag(product: string): string {
  return `cloudflare.api.${product}`;
}
