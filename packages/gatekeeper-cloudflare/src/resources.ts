import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const OBSERVABILITY_SCOPE = "workers-observability.read";
const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;
// How assertCloudflareAccountId spells an account ID, the only spelling a subresource ID may use.
const CANONICAL_ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/;
const ACCOUNT_FRAGMENT = "account";

export const ACCOUNT_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers-and-pages/observability`,
  title: "Cloudflare account observability",
  description: "Query logs, metrics, invocations, and traces across an account's Workers.",
  grantable: true,
};

export const WORKER_OBSERVABILITY_RESOURCE: SupportedResource = {
  urlPattern:
    `${DASHBOARD_ORIGIN}/:accountId/workers/services/view/:workerName/production/observability`,
  title: "Cloudflare Worker observability",
  description: "Query logs, metrics, invocations, and traces for one Worker.",
  grantable: true,
};

export const OBSERVABILITY_RESOURCES = [
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
];

const OBSERVABILITY_PATTERNS = new Set(OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern));

// The API resource's URL patterns. Declared here, not imported from `api-scope.ts`, because that
// module imports this one; `__tests__/resources.test.ts` checks the two agree.
const API_RESOURCE_PATTERNS = [
  `${DASHBOARD_ORIGIN}/:accountId`,
  `${DASHBOARD_ORIGIN}/:accountId/:zoneName`,
];

/**
 * OAuth scopes requested for the Cloudflare API resource, in the dashboard client's dotted scope
 * vocabulary (the one the `cf` CLI requests). They are the ceiling on what an API binding can do:
 * Cloudflare answers 403 for anything outside them, whatever the binding allows. The deployment's
 * OAuth client must allow each one, or Cloudflare refuses the authorization.
 */
export const API_SCOPES = [
  "access.read", "access.write",
  "account-rulesets.read", "account-rulesets.write",
  "account-settings.read", "account-settings.write",
  "account-waf.read", "account-waf.write",
  "analytics.read",
  "argotunnel.read", "argotunnel.write",
  "cache-settings.read", "cache-settings.write", "cache.purge",
  "d1.read", "d1.write",
  "dns.read", "dns.write",
  "load-balancers.read", "load-balancers.write",
  "load-balancing-monitors-and-pools.read", "load-balancing-monitors-and-pools.write",
  "logs.read",
  "memberships.read",
  "notifications.read", "notifications.write",
  "page-rules.read", "page-rules.write",
  "queues.read", "queues.write",
  "ssl-and-certificates.read", "ssl-and-certificates.write",
  "teams.read", "teams.write",
  "transform-rules.read", "transform-rules.write",
  "workers-kv-storage.read", "workers-kv-storage.write",
  "workers-r2.read", "workers-r2.write",
  "workers-routes.read", "workers-routes.write",
  "workers-scripts.read", "workers-scripts.write",
  "zone-dns-settings.read", "zone-dns-settings.write",
  "zone-settings.read", "zone-settings.write",
  "zone-waf.read", "zone-waf.write",
  "zone.read", "zone.write",
];

/** The scope whose presence in a grant means the API resources were granted. */
const API_GRANT_MARKER = "zone.read";

const RESOURCE_PATTERNS = new Set([...OBSERVABILITY_PATTERNS, ...API_RESOURCE_PATTERNS]);

/** Validate and normalize a Cloudflare account ID at an external input boundary. */
export function assertCloudflareAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

export function accountObservabilityUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers-and-pages/observability`;
}

/**
 * The subresource ID every read reports, through an account or a Worker binding alike: the account
 * whose telemetry it queried, `account/<accountId>`.
 */
export function observabilitySubresourceId(accountId: string): string {
  return formatSubresourceId({
    fragments: [{ name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) }],
  });
}

/**
 * The account ID an ID from observabilitySubresourceId names. Throws for any other ID, another
 * spelling of the same account's included.
 */
export function parseObservabilitySubresourceId(id: string): string {
  const { namespace, fragments: [account, ...rest] } = parseSubresourceId(id);
  if (namespace === undefined && rest.length === 0 && account?.name === ACCOUNT_FRAGMENT &&
      CANONICAL_ACCOUNT_ID_PATTERN.test(account.id)) {
    return account.id;
  }
  throw new Error("Not a Cloudflare Workers Observability subresource.");
}

// The Cloudflare API resource's reads get a namespace of their own, so an ID from one resource can
// never be read as the other's: they are checked differently.
const API_NAMESPACE = "api";
const USER_FRAGMENT = "user";
// How Cloudflare spells a user id, and the only spelling a subresource ID may use.
const CANONICAL_USER_ID_PATTERN = /^[a-f\d]{32}$/;

/**
 * The subresource ID every Cloudflare API read reports: the account it read, as the Cloudflare user
 * the connection belongs to sees it, `api/account/<accountId>/user/<userId>`. The user is part of
 * the resource because what a read of an account returns depends on that member's roles there: two
 * members of one account can be shown different things.
 */
export function apiSubresourceId(accountId: string, userId: string): string {
  const user = userId.toLowerCase();
  if (!CANONICAL_USER_ID_PATTERN.test(user)) throw new Error("Not a Cloudflare user id.");
  return formatSubresourceId({
    namespace: API_NAMESPACE,
    fragments: [
      { name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) },
      { name: USER_FRAGMENT, id: user },
    ],
  });
}

/** What an ID from apiSubresourceId names. Throws for any other ID, another spelling included. */
export function parseApiSubresourceId(id: string): { accountId: string; userId: string } {
  const { namespace, fragments: [account, user, ...rest] } = parseSubresourceId(id);
  if (namespace === API_NAMESPACE && rest.length === 0 && account?.name === ACCOUNT_FRAGMENT &&
      CANONICAL_ACCOUNT_ID_PATTERN.test(account.id) && user?.name === USER_FRAGMENT &&
      CANONICAL_USER_ID_PATTERN.test(user.id)) {
    return { accountId: account.id, userId: user.id };
  }
  throw new Error("Not a Cloudflare API subresource.");
}

export function workerObservabilityUrl(accountId: string, workerName: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers/services/view/` +
    `${encodeURIComponent(workerName)}/production/observability`;
}

export function parseObservabilityResourceUrl(url: string): {
  accountId: string;
  workerName?: string;
} {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== DASHBOARD_ORIGIN) throw new Error();
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (segments.length === 3 && segments[1] === "workers-and-pages" &&
        segments[2] === "observability") {
      return { accountId };
    }
    if (segments.length === 7 && segments[1] === "workers" && segments[2] === "services" &&
        segments[3] === "view" && segments[4] && segments[5] === "production" &&
        segments[6] === "observability") {
      return { accountId, workerName: segments[4] };
    }
  } catch {
    // Normalize URL, percent-decoding, and account-ID failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare observability URL: ${url}`);
}

export function observabilityScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  return resourceUrlPatterns === undefined
      || resourceUrlPatterns.some(pattern => OBSERVABILITY_PATTERNS.has(pattern))
    ? [OBSERVABILITY_SCOPE]
    : [];
}

/**
 * Scopes for the API resources among `resourceUrlPatterns`. `undefined` means every type the
 * deployment offers, which includes the API resources only when `apiEnabled`: a deployment whose
 * OAuth client does not allow `API_SCOPES` would otherwise have every "connect all" refused.
 */
export function apiScopesForResources(resourceUrlPatterns: string[] | undefined, apiEnabled: boolean):
    string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  const wanted = resourceUrlPatterns === undefined
    ? apiEnabled
    : resourceUrlPatterns.some(pattern => API_RESOURCE_PATTERNS.includes(pattern));
  return wanted ? [...API_SCOPES] : [];
}

export function grantedObservabilityResourcePatterns(scopes: string[]): string[] {
  return scopes.includes(OBSERVABILITY_SCOPE)
    ? OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern)
    : [];
}

/** The API resource patterns a grant covers. */
export function grantedApiResourcePatterns(scopes: string[]): string[] {
  return scopes.includes(API_GRANT_MARKER) ? [...API_RESOURCE_PATTERNS] : [];
}

/** Every resource pattern a grant covers. */
export function grantedResourcePatterns(scopes: string[]): string[] {
  return [...grantedObservabilityResourcePatterns(scopes), ...grantedApiResourcePatterns(scopes)];
}
