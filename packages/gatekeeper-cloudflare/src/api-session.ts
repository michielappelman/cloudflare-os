// The agent-facing session for one Cloudflare API binding.
//
// Catalog lookups (`searchOperations`, `describeOperation`, `listProducts`) read the bundled spec,
// not the user's data, so they are not observations. Every method that returns Cloudflare data
// records an observation before returning it, and every change is staged for approval by the host.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import { describeRead } from "./api-describe.js";
import type { CloudflareApiHost, PreparedCall } from "./api-gatekeeper.js";
import { bindingReaches } from "./api-scope.js";
import { API_PRODUCTS } from "./api-spec-data.js";
import { MAX_SEARCH_QUERY, type ApiOperation } from "./api-spec.js";
import { isAction, tierOf, type ApiTier } from "./api-tiers.js";
import type {
  CloudflareApiOperation,
  CloudflareApiOperationDetail,
  CloudflareApiProduct,
  CloudflareApiRequest,
  CloudflareApiResult,
  CloudflareApiScope,
  CloudflareApiSession,
} from "./api-types.js";

const DEFAULT_LIST_ITEMS = 1000;
const MAX_LIST_ITEMS = 10_000;
const MAX_LIST_PAGES = 100;

function toPublic(operation: ApiOperation, tier: ApiTier): CloudflareApiOperation {
  return {
    id: operation.id,
    ...(operation.command ? { command: operation.command } : {}),
    product: operation.product,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    access: isAction(tier) ? "change" : "read",
    ...(operation.deprecated ? { deprecated: true } : {}),
  };
}

function countOf(result: unknown): string {
  return Array.isArray(result) ? `returned ${result.length} item(s)` : "returned one result";
}

@validateRpc()
export class CloudflareApiSessionImpl extends RpcTarget implements CloudflareApiSession {
  readonly #host: CloudflareApiHost;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: CloudflareApiHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
  }

  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }

  async scope(): Promise<CloudflareApiScope> {
    const binding = this.#host.binding;
    const zone = binding.zoneName !== undefined ? await this.#host.boundZone() : undefined;
    return {
      accountId: binding.accountId,
      readOnly: binding.readOnly,
      ...(zone ? { zone: { id: zone.id, name: zone.name } } : {}),
      ...(binding.products ? { products: binding.products } : {}),
    };
  }

  async listProducts(): Promise<CloudflareApiProduct[]> {
    const counts = new Map<string, number>();
    for (const operation of this.#host.catalog.all()) {
      if (bindingReaches(this.#host.binding, operation, tierOf(operation))) {
        counts.set(operation.product, (counts.get(operation.product) ?? 0) + 1);
      }
    }
    return [...counts].toSorted(([a], [b]) => a.localeCompare(b)).map(([name, operations]) => ({
      name, operations,
      ...(API_PRODUCTS[name] ? { description: API_PRODUCTS[name] } : {}),
    }));
  }

  async searchOperations(query: string, options: {
    product?: string;
    access?: "read" | "change";
    limit?: number;
  } = {}): Promise<CloudflareApiOperation[]> {
    if (query.length > MAX_SEARCH_QUERY) {
      throw new Error(`Search queries are limited to ${MAX_SEARCH_QUERY} characters.`);
    }
    const binding = this.#host.binding;
    return this.#host.catalog.search(query, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      filter: operation => {
        if (options.product && operation.product !== options.product) return false;
        const tier = tierOf(operation);
        if (options.access && (isAction(tier) ? "change" : "read") !== options.access) return false;
        return bindingReaches(binding, operation, tier);
      },
    }).map(operation => toPublic(operation, tierOf(operation)));
  }

  async describeOperation(idOrCommand: string): Promise<CloudflareApiOperationDetail> {
    const { operation, tier } = this.#host.operation(idOrCommand);
    const schema = this.#host.catalog.schema(operation.id);
    return {
      ...toPublic(operation, tier),
      params: schema.params,
      ...(schema.description ? { description: schema.description } : {}),
      ...(schema.body ? { body: schema.body } : {}),
      ...(operation.bodyRequired ? { bodyRequired: true } : {}),
      ...(schema.result ? { result: schema.result } : {}),
      ...(operation.pagination ? { pagination: operation.pagination } : {}),
      ...(operation.permissions ? { permissions: operation.permissions } : {}),
      ...(operation.confirm ? { warning: operation.confirm } : {}),
    };
  }

  async call(idOrCommand: string, request?: CloudflareApiRequest): Promise<CloudflareApiResult> {
    const { operation, tier } = this.#host.operation(idOrCommand);
    return this.#run(await this.#host.prepare(operation, tier, request));
  }

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    request: Omit<CloudflareApiRequest, "path"> = {},
  ): Promise<CloudflareApiResult> {
    const resolved = this.#host.catalog.resolve(method, path);
    if (!resolved) {
      throw new Error(`No Cloudflare API operation serves ${method} ${path}. Use ` +
        "searchOperations() to find one.");
    }
    const { operation, tier } = this.#host.operation(resolved.operation.id);
    return this.#run(await this.#host.prepare(operation, tier, {
      ...request, path: resolved.pathParams,
    }));
  }

  async #run(call: PreparedCall): Promise<CloudflareApiResult> {
    if (isAction(call.tier)) {
      const staged = await this.#host.stage(call, this.#queue);
      return {
        status: "pending",
        actionId: staged.id,
        message: `"${call.operation.summary}" on the Cloudflare ${call.target} needs the user's ` +
          "approval. If this is running in an agent's executeCode call, return from it now so the " +
          `approval can appear in chat. Afterwards, call getActionResult(${staged.id}) for the outcome.`,
      };
    }
    const response = await this.#host.read(call);
    await this.#queue.authorizeObservation(describeRead(call, countOf(response.result)));
    return {
      status: "ok",
      result: response.result,
      ...(response.resultInfo ? { resultInfo: response.resultInfo } : {}),
    };
  }

  async listAll(
    idOrCommand: string,
    request: CloudflareApiRequest = {},
    options: { maxItems?: number } = {},
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const { operation, tier } = this.#host.operation(idOrCommand);
    if (isAction(tier)) throw new Error(`${operation.id} changes configuration; listAll() only reads.`);
    const maxItems = Math.min(Math.max(1, Math.floor(options.maxItems ?? DEFAULT_LIST_ITEMS)), MAX_LIST_ITEMS);
    const params = this.#host.catalog.schema(operation.id).params;
    const cursorParam = ["cursor", "page_token"].find(name => params.some(p => p.name === name && p.in === "query"));
    const pageMode = params.some(p => p.name === "page" && p.in === "query");
    if (!pageMode && !cursorParam) {
      throw new Error(`${operation.id} is not paginated; use call().`);
    }

    const items: unknown[] = [];
    let truncated = false;
    let page = Number(request.query?.page ?? 1);
    let cursor: string | undefined;
    let first: PreparedCall | undefined;
    for (let pages = 0; ; pages++) {
      if (pages === MAX_LIST_PAGES) { truncated = true; break; }
      const query = { ...request.query };
      if (cursorParam) {
        if (cursor) query[cursorParam] = cursor;
      } else {
        query.page = page;
      }
      const call = await this.#host.prepare(operation, tier, { ...request, query });
      first ??= call;
      const response = await this.#host.read(call);
      const result = response.result;
      if (!Array.isArray(result)) {
        throw new Error(`${operation.id} did not return a list.`);
      }
      const room = maxItems - items.length;
      items.push(...result.slice(0, room));
      if (result.length > room) { truncated = true; break; }

      const info = response.resultInfo ?? {};
      if (cursorParam) {
        const cursors = info.cursors as { after?: unknown } | undefined;
        const next = info.cursor ?? info.next_page_token ?? cursors?.after;
        if (typeof next !== "string" || next === "" || result.length === 0) break;
        cursor = next;
      } else {
        const perPage = Number(info.per_page ?? result.length);
        const totalPages = Number(info.total_pages ?? NaN);
        if (result.length === 0 || result.length < perPage || (!Number.isNaN(totalPages) && page >= totalPages)) {
          break;
        }
        page++;
      }
      if (items.length >= maxItems) { truncated = true; break; }
    }
    await this.#queue.authorizeObservation(describeRead(first!,
      `walked its pages and returned ${items.length} item(s)${truncated ? " (truncated)" : ""}`));
    return { items, truncated };
  }

  async getActionResult(actionId: number): Promise<CloudflareApiResult> {
    if (!Number.isInteger(actionId)) throw new Error("getActionResult() needs an action id.");
    const stored = this.#host.actions.get(actionId);
    if (!stored) throw new Error(`No Cloudflare API change with id ${actionId}.`);
    const operation = this.#host.catalog.get(stored.operationId);
    const name = operation?.summary ?? stored.operationId;
    switch (stored.state) {
      case "pending":
      case "applying":
        return {
          status: "pending", actionId,
          message: stored.state === "applying"
            ? `"${name}" was approved and is being sent to Cloudflare.`
            : `"${name}" is waiting for the user's approval.`,
        };
      case "rejected":
        return { status: "rejected", message: `The user did not approve "${name}".` };
      case "failed":
        return { status: "failed", message: stored.error ?? `"${name}" failed.` };
      case "applied": {
        await this.#queue.authorizeObservation({
          title: `Cloudflare: result of ${name}`.slice(0, 200),
          description: `Read the response to the approved call ${codeSpan(stored.operationId)} on ` +
            `the Cloudflare ${this.#host.target}.`,
        });
        return {
          status: "ok",
          result: JSON.parse(stored.resultJson ?? "null") as unknown,
          ...(stored.resultInfoJson
            ? { resultInfo: JSON.parse(stored.resultInfoJson) as Record<string, unknown> } : {}),
        };
      }
    }
  }

  async findZone(name: string): Promise<{ id: string; name: string; status: string; plan?: string }> {
    if (typeof name !== "string" || name.length === 0 || name.length > 253) {
      throw new Error("Pass a zone name such as example.com.");
    }
    const wanted = name.trim().toLowerCase().replace(/\.$/, "");
    const binding = this.#host.binding;
    const zone = binding.zoneName !== undefined
      ? (wanted === binding.zoneName ? await this.#host.boundZone() : undefined)
      : await this.#host.lookupZoneByName(wanted);
    if (!zone) {
      throw new Error(binding.zoneName !== undefined
        ? `This connection covers the zone ${binding.zoneName} only.`
        : `No zone named ${wanted} in account ${binding.accountId}.`);
    }
    await this.#queue.authorizeObservation({
      title: "Cloudflare: find zone",
      description: `Looked up a zone by name on the Cloudflare ${this.#host.target}.`,
      fields: [{ kind: "inline", label: "Zone", value: zone.name }],
    });
    return {
      id: zone.id, name: zone.name, status: zone.status ?? "unknown",
      ...(zone.plan ? { plan: zone.plan } : {}),
    };
  }
}
