// What a Cloudflare user may do in one account, as `GET /memberships` reports it, and whether one
// member's access covers another's. The Cloudflare API resource uses it to decide who else may see
// what a binding read (see CloudflareApiGatekeeper.verifyObserverAccess).

/** The permission group that grants everything in an account. Cloudflare's ids are global. */
export const SUPER_ADMINISTRATOR_GROUP_ID = "8e23b19e4e0d44c29d239c5688ba8cbb";

/**
 * A member's access to one account:
 * - `groups`: the ids of the permission groups it holds over the whole account;
 * - `"scoped"`: it holds something this comparison cannot rank, such as a policy limited to some
 *   zones, a deny policy, or a shape this code does not know;
 * - `"none"`: the user is not an accepted member of the account;
 * - `"unreadable"`: the connection was not granted `memberships.read`, so Cloudflare was not asked.
 */
export type AccountMembership = { groups: string[] } | "scoped" | "none" | "unreadable";

/** One entry of `GET /memberships`, as far as this file reads it. */
export interface RawMembership {
  status?: unknown;
  account?: { id?: unknown };
  policies?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The membership `raw` describes for `accountId`. Anything unexpected reads as `"scoped"`. */
export function parseMembership(raw: RawMembership, accountId: string): AccountMembership {
  if (raw.status !== "accepted") return "none";
  if (!Array.isArray(raw.policies) || raw.policies.length === 0) return "scoped";
  const wholeAccount = `com.cloudflare.api.account.${accountId.toLowerCase()}`;
  const groups = new Set<string>();
  for (const policy of raw.policies as unknown[]) {
    if (!isRecord(policy) || policy.access !== "allow") return "scoped";
    const { permission_groups: permissionGroups, resource_groups: resourceGroups } = policy;
    if (!Array.isArray(permissionGroups) || permissionGroups.length === 0 ||
        !Array.isArray(resourceGroups) || resourceGroups.length === 0) return "scoped";
    for (const group of resourceGroups as unknown[]) {
      const scope = isRecord(group) ? group.scope : undefined;
      const objects = isRecord(scope) ? scope.objects : undefined;
      if (!isRecord(scope) || typeof scope.key !== "string" ||
          scope.key.toLowerCase() !== wholeAccount || !Array.isArray(objects) ||
          objects.length !== 1 || !isRecord(objects[0]) || objects[0].key !== "*") return "scoped";
    }
    for (const group of permissionGroups as unknown[]) {
      if (!isRecord(group) || typeof group.id !== "string" || !group.id) return "scoped";
      groups.add(group.id.toLowerCase());
    }
  }
  return { groups: [...groups].toSorted() };
}

/**
 * Whether `observer` may do everything `owner` may in the account both memberships are for: it is
 * a Super Administrator there, or holds every permission group the owner holds. False whenever
 * either side cannot be ranked, so a doubt never widens who sees a read.
 */
export function membershipCovers(observer: AccountMembership, owner: AccountMembership): boolean {
  if (typeof observer === "string" || typeof owner === "string") return false;
  if (observer.groups.includes(SUPER_ADMINISTRATOR_GROUP_ID)) return true;
  return owner.groups.length > 0 && owner.groups.every(group => observer.groups.includes(group));
}
