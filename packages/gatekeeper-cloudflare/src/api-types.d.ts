// Types for the Cloudflare API session: the whole Cloudflare REST API (api.cloudflare.com/client/v4)
// for one account or one zone.

/** One Cloudflare API operation. */
export interface CloudflareApiOperation {
  /** The operation's id. Pass it (or `command`) to `call()` or `describeOperation()`. */
  id: string;
  /**
   * Dotted name in the style of the `cf` CLI (`dns.records.create` is `cf dns records create`).
   * Also accepted by `call()`. Absent when two operations would share it; use `id` then.
   */
  command?: string;
  /** Product the operation belongs to, e.g. `"dns"`, `"workers"`, `"zero-trust"`. */
  product: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path template, e.g. `/zones/{zone_id}/dns_records`. */
  path: string;
  summary: string;
  /**
   * `"read"` returns data. `"change"` modifies configuration: `call()` returns `status: "pending"`
   * and the change is made once the user allows it.
   */
  access: "read" | "change";
  deprecated?: boolean;
}

/** A parameter of an operation. */
export interface CloudflareApiParameter {
  name: string;
  /** Where to pass it in `CloudflareApiRequest`: `path` or `query`. */
  in: "path" | "query";
  required?: boolean;
  /** TypeScript-like type. */
  type: string;
  description?: string;
}

/** Everything needed to call one operation. */
export interface CloudflareApiOperationDetail extends CloudflareApiOperation {
  description?: string;
  params: CloudflareApiParameter[];
  /** TypeScript-like shape of the JSON request body, when the operation takes one. */
  body?: string;
  bodyRequired?: boolean;
  /**
   * TypeScript-like shape of `result` in a successful `CloudflareApiResult`. Long shapes end in
   * `…`; read a real response for the rest.
   */
  result?: string;
  /** How lists page: pass `page`/`per_page`, or `cursor`, in `query`. `listAll()` does it for you. */
  pagination?: "page" | "cursor";
  /** API token permission groups that grant this operation. A 403 means the connection lacks one. */
  permissions?: string[];
  /** Cloudflare's own warning for an irreversible or costly operation. */
  warning?: string;
}

/** Parameters for one call. */
export interface CloudflareApiRequest {
  /**
   * Path parameters by name. `account_id` defaults to the connection's account, and `zone_id` to
   * its zone on a zone connection, so you rarely pass either.
   */
  path?: Record<string, string>;
  /** Query parameters. An array repeats the key (`?type=A&type=AAAA`). */
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** JSON request body. */
  body?: unknown;
}

/**
 * Outcome of `call()`, `request()` or `getActionResult()`.
 *
 * A read resolves to `"ok"` straight away. A change resolves to `"pending"`, and later, through
 * `getActionResult()`, to `"ok"`, `"rejected"` or `"failed"`.
 */
export type CloudflareApiResult =
  | {
      status: "ok";
      /** The response's `result`. Credentials Cloudflare returns are replaced with a placeholder. */
      result: unknown;
      /** Paging information (`page`, `per_page`, `total_count`, `cursor`, ...), when present. */
      resultInfo?: Record<string, unknown>;
    }
  | {
      status: "pending";
      /** Pass to `getActionResult()` for the outcome. */
      actionId: number;
      /** What to tell the user. */
      message: string;
    }
  | { status: "rejected"; message: string }
  | {
      status: "failed";
      /**
       * Why the change failed, including Cloudflare's error. It says so when the change may still
       * have taken effect, or when the resource was modified after the change was requested.
       */
      message: string;
    };

/** What this connection may reach. */
export interface CloudflareApiScope {
  accountId: string;
  /** Set on a zone connection. */
  zone?: { id: string; name: string };
  /** When set, only these products' operations can be called. */
  products?: string[];
  /** When true, only `"read"` operations can be called. */
  readOnly: boolean;
}

/** Outcome of a GraphQL Analytics query. */
export interface CloudflareGraphqlResult {
  /** The query's data, as GraphQL returns it. May be partial when `errors` is present. */
  data: unknown;
  /** GraphQL errors, e.g. an unknown field or a dataset the plan does not include. */
  errors?: Array<{ message: string; path?: Array<string | number>; extensions?: Record<string, unknown> }>;
}

/** A product and how many of its operations this connection can call. */
export interface CloudflareApiProduct {
  name: string;
  description?: string;
  operations: number;
}

/**
 * The Cloudflare API for one account or zone.
 *
 * Find operations with `searchOperations()`, read their parameters with `describeOperation()`, then
 * `call()` them. Example:
 *
 * ```ts
 * const zone = await cf.findZone("example.com");
 * const records = await cf.listAll("dns.records.list", {
 *   path: { zone_id: zone.id }, query: { type: "CNAME" },
 * });
 * const created = await cf.call("dns.records.create", {
 *   path: { zone_id: zone.id },
 *   body: { type: "A", name: "api.example.com", content: "192.0.2.10", proxied: true, ttl: 1 },
 * });
 * if (created.status === "pending") {
 *   // Return from this run; the change is made once the user allows it.
 * }
 * ```
 */
export interface CloudflareApiSession {
  /** What this connection may reach. */
  scope(): Promise<CloudflareApiScope>;

  /** Products with operations this connection can call. */
  listProducts(): Promise<CloudflareApiProduct[]>;

  /**
   * Finds operations by keywords matched against their command, summary, path and product, best
   * match first. Only operations this connection can call are returned.
   * @param query Keywords, e.g. `"dns record create"` or `"waf custom rules"`.
   * @param options.limit At most this many results (default 20, maximum 50).
   */
  searchOperations(query: string, options?: {
    product?: string;
    access?: "read" | "change";
    limit?: number;
  }): Promise<CloudflareApiOperation[]>;

  /** Parameters, body and result shape of one operation, by `id` or `command`. */
  describeOperation(idOrCommand: string): Promise<CloudflareApiOperationDetail>;

  /**
   * Calls one operation, by `id` or `command`.
   *
   * Throws when the operation is unknown, outside this connection, missing a required parameter,
   * or when Cloudflare refuses a read (the error carries Cloudflare's message).
   */
  call(idOrCommand: string, request?: CloudflareApiRequest): Promise<CloudflareApiResult>;

  /**
   * Calls the operation serving a concrete method and path, e.g.
   * `request("GET", "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records", { query: { type: "A" } })`.
   */
  request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    request?: Omit<CloudflareApiRequest, "path">,
  ): Promise<CloudflareApiResult>;

  /**
   * Reads every page of a paginated `"read"` operation and concatenates the results.
   * @param options.maxItems Stop after this many items (default 1000, maximum 10000).
   * @returns The items, and `truncated: true` when more remained.
   */
  listAll(
    idOrCommand: string,
    request?: CloudflareApiRequest,
    options?: { maxItems?: number },
  ): Promise<{ items: unknown[]; truncated: boolean }>;

  /** The outcome of a change that `call()` returned as `"pending"`. */
  getActionResult(actionId: number): Promise<CloudflareApiResult>;

  /**
   * Runs a query against the GraphQL Analytics API (traffic, security events, Workers and other
   * product analytics). The query must have this shape:
   *
   * - one `query` operation, without fragments;
   * - at the top level only `viewer` (or, to explore the schema, only `__schema` / `__type`);
   * - under `viewer` only `zones`, `accounts` and `budget`;
   * - `zones(filter: { zoneTag: "…" })` or `zones(filter: { zoneTag_in: [...] })` naming zones of
   *   this connection, as literals or variables. On a zone connection the filter may be left out;
   * - `accounts` may leave out its filter (it is this connection's account), and is not available
   *   on a zone connection.
   *
   * Other filters (time ranges, hostnames, ...) go on the datasets inside, as usual. Example:
   *
   * ```ts
   * const { data, errors } = await cf.graphql(`
   *   query ($zone: String!, $since: Time!) {
   *     viewer { zones(filter: { zoneTag: $zone }) {
   *       httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $since },
   *                                  orderBy: [count_DESC]) {
   *         count dimensions { clientCountryName }
   *       }
   *     } }
   *   }`, { zone: zone.id, since: "2026-10-29T00:00:00Z" });
   * ```
   *
   * Throws when the query has another shape or names a zone outside this connection.
   */
  graphql(query: string, variables?: Record<string, unknown>): Promise<CloudflareGraphqlResult>;

  /**
   * Fields, arguments, input fields and enum values of one GraphQL Analytics type. Without a name,
   * the root query type; follow field types from there (`viewer` → zone and account datasets).
   */
  describeGraphqlType(name?: string): Promise<unknown>;

  /** Looks up a zone by name. Throws when it is not in this connection's account or zone. */
  findZone(name: string): Promise<{ id: string; name: string; status: string; plan?: string }>;
}
