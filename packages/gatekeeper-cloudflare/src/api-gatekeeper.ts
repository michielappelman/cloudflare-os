// The Cloudflare API resource: one account or one zone, through the whole REST API.
//
// Every call goes through `prepare()`, which resolves the request to a catalog operation and checks
// it against the binding before anything is sent:
//   - the operation's product and tier against the binding's narrowing (`api-scope.ts`);
//   - an `account_id` against the bound account;
//   - a `zone_id` against the bound zone, or, on an account binding, against the zone's own account
//     as Cloudflare reports it;
//   - `/zones` itself is pinned to the bound account, and its list is re-filtered on the way out.
// Reads are recorded as observations. Changes are staged and only sent from `applyAction()`, which
// runs the same checks again: a zone can move between accounts while a change waits.

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ApiActionStore, type StoredApiAction } from "./api-actions.js";
import {
  CloudflareApiClient, CloudflareApiError, encodeBody, provesNotApplied,
  type ApiQueryValue, type ApiResponse,
} from "./api-client.js";
import { describeChange, productLabel, type DescribedCall } from "./api-describe.js";
import {
  ROOT_TYPE_QUERY, scopeGraphqlQuery, typeQuery, verifyGraphqlData, type ScopedGraphql,
} from "./api-graphql.js";
import { redactResult } from "./api-redact.js";
import {
  apiResourceUrl, bindingReaches, operationRefusal, pathScopeOf, type ApiBinding,
} from "./api-scope.js";
import { apiCatalog } from "./api-spec-data.js";
import type { ApiCatalog, ApiOperation } from "./api-spec.js";
import { actionKindTag, isAction, tierOf, type ApiTier } from "./api-tiers.js";
import { CloudflareApiSessionImpl } from "./api-session.js";
import type { CloudflareApiRequest, CloudflareApiSession } from "./api-types.js";
import API_TYPES_CODE from "./api-types.txt";
import { obsContext } from "./observability.js";
import { VENDOR_ID } from "./vendor.js";

const logger = obsContext.createLogger({ component: "gatekeeper.cloudflare.api", vendorId: VENDOR_ID });

const ZONE_CACHE_TTL_MS = 5 * 60 * 1000;
/** The product a narrowed binding must include to use the GraphQL Analytics API. */
export const GRAPHQL_PRODUCT = "analytics";
const MAX_PARAM_LENGTH = 512;

/** Props the user entrypoint passes for one binding; see `parseApiResourceUrl`. */
export type CloudflareApiGatekeeperProps = {
  userObjectId: string;
  accountId: string;
  zoneName?: string;
  products?: string[];
  readOnly: boolean;
};

type ZoneInfo = { id: string; name: string; accountId: string; status?: string; plan?: string };
type CachedZone = ZoneInfo & { expires: number };

/** A request that passed every binding check, ready to send or stage. */
export interface PreparedCall extends DescribedCall {
  /** Set for `GET /zones`, whose results are re-filtered to the bound account. */
  filterZonesToAccount?: boolean;
}

function invalid(message: string): never {
  throw new Error(message);
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function templateParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "null");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

@validateRpc()
export class CloudflareApiGatekeeper
    extends DurableObject<Cloudflare.Env, CloudflareApiGatekeeperProps>
    implements Gatekeeper<CloudflareApiSession> {
  #host: CloudflareApiHost | undefined;

  get #api(): CloudflareApiHost {
    this.#host ??= new CloudflareApiHost(this.ctx);
    return this.#host;
  }

  async describe(): Promise<ResourceDescription> {
    const { zoneName, products, readOnly } = this.ctx.props;
    const reach = products ? ` (${products.join(", ")})` : "";
    return {
      url: apiResourceUrl(this.#api.binding),
      title: zoneName ?? `Cloudflare account ${this.ctx.props.accountId}`,
      snippet: `${readOnly ? "Read" : "Read and change"} the configuration of this Cloudflare ` +
        `${zoneName !== undefined ? "zone" : "account"} through the Cloudflare API${reach}.`,
      suggestedBindingName: zoneName !== undefined ? "CLOUDFLARE_ZONE_API" : "CLOUDFLARE_API",
      tsType: "CloudflareApiSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return API_TYPES_CODE; }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const binding = this.#api.binding;
    if (binding.readOnly) return [];
    const products = new Set<string>();
    for (const operation of this.#api.catalog.all()) {
      const tier = tierOf(operation);
      if (tier === "write" && bindingReaches(binding, operation, tier)) products.add(operation.product);
    }
    return [...products].toSorted().map(product => ({
      tag: actionKindTag(product), label: productLabel(product),
    }));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareApiSession> {
    return new CloudflareApiSessionImpl(this.#api, approvalQueue.dup());
  }

  /**
   * Refuses every collaborator. A binding can span every product in an account, and a member's
   * Cloudflare role may cover only some of them, so there is no single check that proves a
   * collaborator could read everything this binding has read.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Gadgets with a Cloudflare API connection can only be opened by the person " +
      "who connected it.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number, _cache?: RpcStub<GitCache>): Promise<void> {
    await this.#api.apply(action);
  }

  async rejectAction(action: number): Promise<void> {
    this.#api.actions.reject(action);
  }

  async revertAction(_action: number): Promise<{ message: string }> {
    return {
      message: "Cloudflare API changes are not reverted automatically. Make the opposite change " +
        "in the dashboard or with another call.",
    };
  }
}

/**
 * Everything the session needs from its binding, kept off the Durable Object so none of it is
 * callable over RPC: only the `Gatekeeper` methods above are.
 */
export class CloudflareApiHost {
  readonly #ctx: DurableObjectState<CloudflareApiGatekeeperProps>;
  #actions: ApiActionStore | undefined;

  constructor(ctx: DurableObjectState<CloudflareApiGatekeeperProps>) {
    this.#ctx = ctx;
  }

  private get ctx(): DurableObjectState<CloudflareApiGatekeeperProps> { return this.#ctx; }

  /** The binding this instance serves. */
  get binding(): ApiBinding {
    const { accountId, zoneName, products, readOnly } = this.ctx.props;
    return {
      accountId, readOnly,
      ...(zoneName !== undefined ? { zoneName } : {}),
      ...(products !== undefined ? { products } : {}),
    };
  }

  get catalog(): ApiCatalog { return apiCatalog(); }

  /** How descriptions name this binding. */
  get target(): string {
    return this.ctx.props.zoneName !== undefined
      ? `zone ${this.ctx.props.zoneName}`
      : `account ${this.ctx.props.accountId}`;
  }

  get actions(): ApiActionStore {
    this.#actions ??= new ApiActionStore(this.ctx.storage.sql);
    return this.#actions;
  }

  get client(): CloudflareApiClient {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return new CloudflareApiClient(() => account.getAccessToken());
  }

  // ---------------------------------------------------------------------------------------------
  // Used by the session.

  /** Resolves an operation by id or command, refusing one the binding can never call. */
  operation(idOrCommand: string): { operation: ApiOperation; tier: ApiTier } {
    if (typeof idOrCommand !== "string" || idOrCommand.length === 0 || idOrCommand.length > 200) {
      invalid("Pass an operation id or command.");
    }
    const operation = this.catalog.get(idOrCommand);
    if (!operation) {
      invalid(`Unknown Cloudflare API operation "${idOrCommand}". Use searchOperations() to ` +
        "find one.");
    }
    const tier = tierOf(operation);
    if (!bindingReaches(this.binding, operation, tier)) {
      invalid(operationRefusal(this.binding, operation, tier,
        pathScopeOf(operation, { account_id: this.binding.accountId }))
        ?? `${operation.id} is outside this connection.`);
    }
    return { operation, tier };
  }

  /** Checks a call against the binding and fills in defaults. Nothing is sent to change anything. */
  async prepare(operation: ApiOperation, tier: ApiTier, request: CloudflareApiRequest = {}):
      Promise<PreparedCall> {
    const binding = this.binding;
    const names = templateParams(operation.path);
    const pathParams: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.path ?? {})) {
      if (!names.includes(name)) invalid(`${operation.id} has no path parameter "${name}".`);
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_PARAM_LENGTH) {
        invalid(`Path parameter "${name}" must be a non-empty string.`);
      }
      pathParams[name] = value;
    }
    if (names.includes("account_id")) pathParams.account_id ??= binding.accountId;
    if (names.includes("zone_id") && binding.zoneName !== undefined) {
      pathParams.zone_id ??= (await this.boundZone()).id;
    }
    for (const name of names) {
      if (pathParams[name] === undefined) invalid(`${operation.id} needs the path parameter "${name}".`);
    }

    const scope = pathScopeOf(operation, pathParams);
    const refusal = operationRefusal(binding, operation, tier, scope);
    if (refusal) invalid(refusal);

    let query = request.query === undefined ? undefined : { ...request.query };
    let zone: ZoneInfo | undefined;
    let filterZonesToAccount = false;
    switch (scope.kind) {
      case "account":
        if (!sameId(scope.accountId, binding.accountId)) {
          invalid(`This connection covers account ${binding.accountId} only.`);
        }
        break;
      case "zone":
        zone = await this.zoneInScope(scope.zoneId);
        break;
      case "zones-root":
        if (operation.method === "GET") {
          const asked = query?.["account.id"];
          if (asked !== undefined && (typeof asked !== "string" || !sameId(asked, binding.accountId))) {
            invalid(`This connection covers account ${binding.accountId} only.`);
          }
          query = { ...query, "account.id": binding.accountId };
          filterZonesToAccount = true;
        } else {
          const accountId = (request.body as { account?: { id?: unknown } } | undefined)?.account?.id;
          if (typeof accountId !== "string" || !sameId(accountId, binding.accountId)) {
            invalid(`Set body.account.id to this connection's account, ${binding.accountId}.`);
          }
        }
        break;
      case "public":
      case "outside":
        break;
    }

    const bodyText = encodeBody(operation, request.body);
    return {
      operation, tier, pathParams, bodyText, target: this.target,
      ...(query !== undefined ? { query } : {}),
      ...(zone ? { zone: { id: zone.id, name: zone.name } } : {}),
      url: CloudflareApiClient.url(operation, { pathParams, ...(query ? { query } : {}) }),
      ...(filterZonesToAccount ? { filterZonesToAccount } : {}),
    };
  }

  /** Sends a prepared read and returns its redacted response. */
  async read(call: PreparedCall): Promise<ApiResponse> {
    if (isAction(call.tier)) throw new Error("Changes are staged, not read.");
    const response = await this.#send(call);
    let result = redactResult(call.operation, response.result);
    if (call.filterZonesToAccount && Array.isArray(result)) {
      // The account filter is a request, not a guarantee: anything another account owns is
      // dropped here, whatever the provider returned.
      const accountId = this.binding.accountId;
      result = result.filter(zone =>
        typeof (zone as ZoneLike)?.account?.id === "string" && sameId((zone as ZoneLike).account!.id!, accountId));
    }
    return { ...response, result };
  }

  /** Stages a prepared change, reading the current state first when it replaces one resource. */
  async stage(call: PreparedCall, queue: Pick<RpcStub<ApprovalQueue>, "submitAction">):
      Promise<StoredApiAction> {
    let before: { shown: unknown; digest: string } | undefined;
    const reader = ["PUT", "PATCH", "DELETE"].includes(call.operation.method)
      ? this.catalog.readerFor(call.operation) : undefined;
    if (reader && tierOf(reader) === "read") {
      try {
        const current = await this.client.send(reader, { pathParams: call.pathParams });
        before = { shown: redactResult(reader, current.result), digest: await digest(current.result) };
      } catch (error) {
        // Without a snapshot the change is still shown in full; it just is not checked for staleness.
        logger.info("could not read state before a change", {
          event: "api.before.unavailable",
          status: error instanceof CloudflareApiError ? error.status : undefined,
          providerCodes: error instanceof CloudflareApiError ? error.codes.join(",") : undefined,
        });
      }
    }

    const staged = this.actions.stage({
      operationId: call.operation.id,
      pathParams: call.pathParams,
      ...(call.query ? { query: call.query } : {}),
      ...(call.bodyText !== undefined ? { bodyText: call.bodyText } : {}),
      ...(before ? { beforeDigest: before.digest } : {}),
    });
    try {
      await queue.submitAction(staged.id, describeChange(call, before?.shown));
    } catch (error) {
      this.actions.discard(staged.id);
      throw error;
    }
    return staged;
  }

  /** Applies an approved change after checking it again. */
  async apply(id: number): Promise<void> {
    const stored = this.actions.claim(id);
    if (!stored) return;
    const fail = (message: string, retryable: boolean): never => {
      this.actions.fail(id, message, retryable);
      throw new Error(message);
    };

    const operation = this.catalog.get(stored.operationId);
    if (!operation) fail(`The operation ${stored.operationId} is no longer known.`, false);
    const tier = tierOf(operation!);
    let call: PreparedCall;
    try {
      call = await this.prepare(operation!, tier, {
        path: stored.pathParams,
        ...(stored.query ? { query: stored.query } : {}),
        ...(stored.bodyText !== undefined ? { body: JSON.parse(stored.bodyText) } : {}),
      });
    } catch (error) {
      return fail(`This change is no longer allowed: ${(error as Error).message}`, false);
    }
    // Sent exactly as approved, not re-serialized.
    if (stored.bodyText !== undefined) call.bodyText = stored.bodyText;

    if (stored.beforeDigest) {
      const reader = this.catalog.readerFor(operation!)!;
      let current: string;
      try {
        current = await digest((await this.client.send(reader, { pathParams: call.pathParams })).result);
      } catch (error) {
        return fail(`Could not confirm the resource is unchanged: ${(error as Error).message}`, true);
      }
      if (current !== stored.beforeDigest) {
        return fail("The resource changed after this change was requested, so it was not made. " +
          "Read it again and request the change anew.", false);
      }
    }

    let response: ApiResponse;
    try {
      response = await this.#send(call);
    } catch (error) {
      const notApplied = provesNotApplied(error);
      logger.warn("approved change failed", {
        event: notApplied ? "api.apply.failed" : "api.apply.outcome-unknown",
        status: error instanceof CloudflareApiError ? error.status : undefined,
        providerCodes: error instanceof CloudflareApiError ? error.codes.join(",") : undefined,
      });
      return fail(notApplied
        ? (error as Error).message
        : "The request failed after it was sent, so it may or may not have taken effect. Check " +
          `the resource before requesting it again. (${(error as Error).message})`, notApplied);
    }
    this.actions.succeed(
      id,
      JSON.stringify(redactResult(operation!, response.result) ?? null),
      response.resultInfo ? JSON.stringify(response.resultInfo) : undefined,
    );
    logger.info("approved change applied", { event: "api.apply.applied", status: response.status });
  }

  /** Product narrowing treats the GraphQL Analytics API as the `analytics` product. */
  #requireAnalytics(): void {
    const products = this.binding.products;
    if (products && !products.includes(GRAPHQL_PRODUCT)) {
      invalid(`This connection is limited to ${products.join(", ")}; GraphQL Analytics belongs to ` +
        `${GRAPHQL_PRODUCT}.`);
    }
  }

  /**
   * Runs a GraphQL Analytics query after scoping it to the binding (see `api-graphql.ts`), and
   * confirms every zone it names belongs to the bound account before it is sent.
   */
  async graphql(query: string, variables?: Record<string, unknown>): Promise<{
    data: unknown; errors?: unknown[]; scoped: ScopedGraphql; zones: string[];
  }> {
    this.#requireAnalytics();
    const binding = this.binding;
    const zoneId = binding.zoneName !== undefined ? (await this.boundZone()).id : undefined;
    const scoped = scopeGraphqlQuery(query, variables, {
      accountId: binding.accountId, ...(zoneId ? { zoneId } : {}),
    });
    const zones: string[] = [];
    for (const tag of scoped.zoneTags) zones.push((await this.zoneInScope(tag)).name);
    const response = await this.client.graphql(scoped.query, scoped.variables);
    return {
      data: verifyGraphqlData(response.data, scoped.checks),
      ...(response.errors ? { errors: response.errors } : {}),
      scoped, zones,
    };
  }

  /** Introspects one GraphQL Analytics type, or the root query type when `name` is omitted. */
  async graphqlType(name?: string): Promise<unknown> {
    this.#requireAnalytics();
    let typeName = name;
    if (typeName === undefined) {
      const root = await this.client.graphql(ROOT_TYPE_QUERY, {});
      typeName = (root.data as { __schema?: { queryType?: { name?: string } } } | null)
        ?.__schema?.queryType?.name;
      if (!typeName) throw new Error("Cloudflare did not report the GraphQL root type.");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(typeName)) invalid("Pass a GraphQL type name.");
    const response = await this.client.graphql(typeQuery(), { name: typeName });
    const type = (response.data as { __type?: unknown } | null)?.__type;
    if (!type) throw new Error(`No GraphQL Analytics type named ${typeName}.`);
    return type;
  }

  /** The bound zone of a zone binding, resolved once from its name. */
  async boundZone(): Promise<ZoneInfo> {
    const zoneName = this.ctx.props.zoneName;
    if (zoneName === undefined) throw new Error("This connection is not limited to one zone.");
    const cached = this.ctx.storage.kv.get<ZoneInfo>("boundZone");
    if (cached && cached.name === zoneName) return cached;
    const zone = await this.lookupZoneByName(zoneName);
    if (!zone) throw new Error(`The zone ${zoneName} was not found in account ${this.ctx.props.accountId}.`);
    this.ctx.storage.kv.put<ZoneInfo>("boundZone", zone);
    return zone;
  }

  /** Finds a zone of the bound account by name, or undefined. */
  async lookupZoneByName(name: string): Promise<ZoneInfo | undefined> {
    const list = this.catalog.resolve("GET", "/zones")?.operation;
    if (!list) throw new Error("The zone list operation is missing from the catalog.");
    const response = await this.client.send(list, {
      pathParams: {}, query: { name, "account.id": this.ctx.props.accountId },
    });
    const zones = Array.isArray(response.result) ? response.result as ZoneLike[] : [];
    const match = zones.find(zone => zone?.name === name && typeof zone.id === "string"
      && sameId(zone.account?.id ?? "", this.ctx.props.accountId));
    return match ? toZoneInfo(match) : undefined;
  }

  /** Confirms a zone id is inside the binding and returns it. */
  async zoneInScope(zoneId: string): Promise<ZoneInfo> {
    const binding = this.binding;
    if (binding.zoneName !== undefined) {
      const bound = await this.boundZone();
      if (!sameId(zoneId, bound.id)) invalid(`This connection covers the zone ${bound.name} only.`);
      return bound;
    }
    const zone = await this.#zone(zoneId);
    if (!zone || !sameId(zone.accountId, binding.accountId)) {
      invalid(`The zone ${zoneId} is not in account ${binding.accountId}.`);
    }
    return zone;
  }

  async #zone(zoneId: string): Promise<ZoneInfo | undefined> {
    if (!/^[a-f0-9]{32}$/i.test(zoneId)) return undefined;
    const key = `zone:${zoneId.toLowerCase()}`;
    const cached = this.ctx.storage.kv.get<CachedZone>(key);
    if (cached && cached.expires > Date.now()) return cached;
    const get = this.catalog.resolve("GET", `/zones/${zoneId}`)?.operation;
    if (!get) throw new Error("The zone read operation is missing from the catalog.");
    try {
      const zone = toZoneInfo((await this.client.send(get, { pathParams: { zone_id: zoneId } })).result as ZoneLike);
      if (!zone) return undefined;
      this.ctx.storage.kv.put<CachedZone>(key, { ...zone, expires: Date.now() + ZONE_CACHE_TTL_MS });
      return zone;
    } catch (error) {
      if (error instanceof CloudflareApiError && [400, 403, 404].includes(error.status)) return undefined;
      throw error;
    }
  }

  async #send(call: PreparedCall): Promise<ApiResponse> {
    try {
      return await this.client.send(call.operation, {
        pathParams: call.pathParams, ...(call.query ? { query: call.query } : {}),
      }, call.bodyText);
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        logger.info("Cloudflare API call failed", {
          event: "api.call.failed", status: error.status, providerCodes: error.codes.join(","),
        });
      }
      throw error;
    }
  }
}

type ZoneLike = {
  id?: string; name?: string; status?: string;
  account?: { id?: string };
  plan?: { name?: string };
};

function toZoneInfo(zone: ZoneLike | undefined): ZoneInfo | undefined {
  if (!zone || typeof zone.id !== "string" || typeof zone.name !== "string"
      || typeof zone.account?.id !== "string") {
    return undefined;
  }
  return {
    id: zone.id, name: zone.name, accountId: zone.account.id,
    ...(typeof zone.status === "string" ? { status: zone.status } : {}),
    ...(typeof zone.plan?.name === "string" ? { plan: zone.plan.name } : {}),
  };
}

export type { ApiQueryValue };
