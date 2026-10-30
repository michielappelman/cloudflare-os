// Resource URLs and the binding boundary for the Cloudflare API resource.
//
// A binding is one account, or one zone in it, optionally narrowed to some products and to reads
// only. The narrowing lives in the URL's fragment so both grants share one `urlPattern` each:
//
//   https://dash.cloudflare.com/<accountId>                      whole account
//   https://dash.cloudflare.com/<accountId>/<zone name>          one zone
//   …#products=dns,rulesets&access=read                          narrowed (either level)
//
// Everything here is pure. Checks that need Cloudflare -- which account a zone belongs to -- are
// made by the gatekeeper with the answers from `pathScopeOf`.
//
// `src/configurator/cloudflare-api-configurator-ui.tsx` duplicates this grammar (configurators
// cannot import runtime code); `__tests__/configurator-url.test.ts` keeps the copies in step.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { ApiOperation } from "./api-spec.js";
import { isAction, type ApiTier } from "./api-tiers.js";
import { assertCloudflareAccountId } from "./resources.js";

const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A registrable zone name in its ASCII (Punycode) form: labels of letters, digits and hyphens.
const ZONE_NAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const MAX_PRODUCTS = 64;

export const ACCOUNT_API_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId`,
  title: "Cloudflare account (API)",
  description: "Read and change an account's configuration through the Cloudflare API: zones, " +
    "DNS, security rules, Workers, Zero Trust and more. Changes wait for your approval.",
  grantable: true,
};

export const ZONE_API_RESOURCE: SupportedResource = {
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/:zoneName`,
  title: "Cloudflare zone (API)",
  description: "Read and change one zone's configuration through the Cloudflare API. Changes " +
    "wait for your approval.",
  grantable: true,
  groupedWith: ACCOUNT_API_RESOURCE.urlPattern,
};

export const API_RESOURCES = [ACCOUNT_API_RESOURCE, ZONE_API_RESOURCE];

/** What one API binding may reach. */
export interface ApiBinding {
  accountId: string;
  /** Present for a zone binding: its name, which the gatekeeper resolves to an id. */
  zoneName?: string;
  /** Present when narrowed: the only products whose operations are callable. Sorted, unique. */
  products?: string[];
  /** When true, only `read`-tier operations are callable. */
  readOnly: boolean;
}

/** Validates and normalizes a zone name. */
export function assertZoneName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  if (!ZONE_NAME_PATTERN.test(normalized)) throw new Error(`Invalid zone name: ${name}`);
  return normalized;
}

function normalizeProducts(products: readonly string[]): string[] {
  const unique = [...new Set(products.map(p => p.trim().toLowerCase()).filter(Boolean))].toSorted();
  if (unique.length === 0) throw new Error("A product-narrowed binding needs at least one product.");
  if (unique.length > MAX_PRODUCTS) throw new Error(`At most ${MAX_PRODUCTS} products.`);
  for (const product of unique) {
    if (!PRODUCT_PATTERN.test(product)) throw new Error(`Invalid product name: ${product}`);
  }
  return unique;
}

/** The canonical resource URL for a binding. */
export function apiResourceUrl(binding: ApiBinding): string {
  const base = `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(binding.accountId)}` +
    (binding.zoneName === undefined ? "" : `/${assertZoneName(binding.zoneName)}`);
  const fragment: string[] = [];
  if (binding.products !== undefined) {
    fragment.push(`products=${normalizeProducts(binding.products).join(",")}`);
  }
  if (binding.readOnly) fragment.push("access=read");
  return fragment.length > 0 ? `${base}#${fragment.join("&")}` : base;
}

/** Parses an account or zone API resource URL. Unknown fragment keys are refused, not ignored. */
export function parseApiResourceUrl(url: string): ApiBinding {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Unsupported Cloudflare API resource URL: ${url}`);
  }
  if (parsed.origin !== DASHBOARD_ORIGIN || parsed.search !== "") {
    throw new Error(`Unsupported Cloudflare API resource URL: ${url}`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 1 || segments.length > 2) {
    throw new Error(`Unsupported Cloudflare API resource URL: ${url}`);
  }
  const binding: ApiBinding = {
    accountId: assertCloudflareAccountId(segments[0]!),
    readOnly: false,
  };
  if (segments.length === 2) binding.zoneName = assertZoneName(segments[1]!);

  // A fragment key the parser does not know could be a narrowing a newer configurator meant, so it
  // is an error: dropping it would silently widen the grant.
  const params = new URLSearchParams(parsed.hash.slice(1));
  for (const [key, value] of params) {
    if (key === "products") {
      if (binding.products) throw new Error("`products` may appear once.");
      binding.products = normalizeProducts(value.split(","));
    } else if (key === "access") {
      if (value !== "read") throw new Error(`Unsupported access mode: ${value}`);
      binding.readOnly = true;
    } else {
      throw new Error(`Unsupported Cloudflare API resource option: ${key}`);
    }
  }
  return binding;
}

/** Where a request's path places it relative to accounts and zones. */
export type PathScope =
  | { kind: "account"; accountId: string }
  | { kind: "zone"; zoneId: string }
  /** `/zones` itself: the list (filtered to the account) and zone creation. */
  | { kind: "zones-root" }
  /** Public data that belongs to no account: Radar and Cloudflare's IP ranges. */
  | { kind: "public" }
  | { kind: "outside" };

/** Classifies a request by the first segments of its path. */
export function pathScopeOf(operation: ApiOperation, pathParams: Record<string, string>): PathScope {
  const template = operation.path;
  if (template.startsWith("/accounts/{account_id}")) {
    return { kind: "account", accountId: pathParams.account_id ?? "" };
  }
  if (template.startsWith("/zones/{zone_id}")) {
    return { kind: "zone", zoneId: pathParams.zone_id ?? "" };
  }
  if (template === "/zones") return { kind: "zones-root" };
  if (operation.method === "GET" && (template.startsWith("/radar/") || template === "/ips")) {
    return { kind: "public" };
  }
  return { kind: "outside" };
}

/**
 * Refuses an operation the binding can never call, whatever its parameters: a product outside the
 * narrowing, a change on a read-only binding, a blocked operation, or a path outside every account.
 * @returns The refusal message, or undefined when the operation may proceed to the parameter checks.
 */
export function operationRefusal(
  binding: ApiBinding, operation: ApiOperation, tier: ApiTier, scope: PathScope,
): string | undefined {
  if (tier === "blocked") {
    return `${operation.id} returns a live credential, so this connection does not call it.`;
  }
  if (binding.products && !binding.products.includes(operation.product)) {
    return `This connection is limited to ${binding.products.join(", ")}; ` +
      `${operation.id} belongs to ${operation.product}.`;
  }
  if (binding.readOnly && isAction(tier)) {
    return `This connection is read-only; ${operation.id} changes configuration.`;
  }
  switch (scope.kind) {
    case "outside":
      return `${operation.path} is not part of a Cloudflare account, so this connection cannot ` +
        "reach it.";
    case "account":
      if (binding.zoneName !== undefined) {
        return `This connection covers the zone ${binding.zoneName} only; ${operation.path} is ` +
          "an account-level operation.";
      }
      return undefined;
    case "zones-root":
      if (binding.zoneName !== undefined) {
        return `This connection covers the zone ${binding.zoneName} only.`;
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Whether a catalog entry is something this binding could call, for search and listing. */
export function bindingReaches(binding: ApiBinding, operation: ApiOperation, tier: ApiTier): boolean {
  const template = operation.path;
  const scope: PathScope = template.startsWith("/accounts/{account_id}")
    ? { kind: "account", accountId: binding.accountId }
    : template.startsWith("/zones/{zone_id}") ? { kind: "zone", zoneId: "" }
      : pathScopeOf(operation, {});
  return operationRefusal(binding, operation, tier, scope) === undefined;
}
