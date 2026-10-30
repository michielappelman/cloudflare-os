// The Cloudflare API operation catalog, compiled from Cloudflare's OpenAPI document by
// `scripts/generate-api-spec.ts`. Everything the API resource decides -- whether a request names a
// known operation, which binding may reach it, how it is approved -- starts from an `ApiOperation`,
// so a request that resolves to none is refused rather than forwarded unchecked.
//
// This module is pure: the data is passed in, so the Node tests can build a catalog from fixtures
// and `api-spec-data.ts` owns the (large) bundled data.

/** HTTP methods the catalog contains. */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One operation from the index (`src/api-spec/operations.json`). */
export interface ApiOperation {
  /** OpenAPI `operationId`; unique. */
  id: string;
  /** CLI-style name (`dns.records.create`), absent when two operations would share it. */
  command?: string;
  /** First segment of the SDK group (`dns`, `zero-trust`), the unit of product narrowing. */
  product: string;
  method: ApiMethod;
  /** Path template relative to `/client/v4`, e.g. `/zones/{zone_id}/dns_records`. */
  path: string;
  summary: string;
  /** Cloudflare's own warning text for operations its CLI asks to confirm. */
  confirm?: string;
  deprecated?: boolean;
  pagination?: "page" | "cursor";
  /** `"json"`, or the media type of a request body this gatekeeper does not send. */
  body?: string;
  bodyRequired?: boolean;
  response: "json" | "text" | "binary" | "none";
  /** API token permission groups that grant the operation. */
  permissions?: string[];
}

/** One parameter, as rendered by the generator. */
export interface ApiParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  /** TypeScript-like type text. */
  type: string;
  description?: string;
}

/** Per-operation detail (`src/api-spec/schemas.txt`), loaded on demand. */
export interface ApiOperationSchema {
  description?: string;
  params: ApiParameter[];
  /** TypeScript-like text for the JSON request body. */
  body?: string;
  /** TypeScript-like text for the `result` member of the response envelope. */
  result?: string;
}

/** The operation a concrete request resolved to, with its decoded path parameters. */
export interface ResolvedRequest {
  operation: ApiOperation;
  pathParams: Record<string, string>;
}

const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_RESULTS = 20;
/** Searches longer than this are refused rather than tokenized. */
export const MAX_SEARCH_QUERY = 200;

type Segment = { literal: string } | { param: string };

function parseTemplate(path: string): Segment[] {
  return path.split("/").filter(Boolean).map(part => {
    const match = /^\{([^}]+)\}$/.exec(part);
    return match ? { param: match[1]! } : { literal: part };
  });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1);
}

/** Splits `/a/b?c` style input into decoded path segments, refusing traversal and empty segments. */
export function splitConcretePath(path: string): string[] {
  if (!path.startsWith("/")) throw new Error(`API paths start with "/": ${path}`);
  if (/[?#]/.test(path)) {
    throw new Error("Pass query parameters in `query`, not in the path.");
  }
  const raw = path.split("/").slice(1);
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map(part => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new Error(`Malformed path segment: ${part}`);
    }
    if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/")) {
      throw new Error("API paths may not contain empty, '.', '..' or encoded '/' segments.");
    }
    return decoded;
  });
}

/** Lookup, routing and search over the compiled operation index. */
export class ApiCatalog {
  readonly #byId = new Map<string, ApiOperation>();
  readonly #byCommand = new Map<string, ApiOperation>();
  readonly #routes: Array<{ operation: ApiOperation; segments: Segment[]; literals: number }> = [];
  readonly #tokens = new Map<string, string[]>();
  readonly #loadSchemas: () => Record<string, ApiOperationSchema>;
  #schemas: Record<string, ApiOperationSchema> | undefined;

  constructor(operations: ApiOperation[], loadSchemas: () => Record<string, ApiOperationSchema>) {
    this.#loadSchemas = loadSchemas;
    for (const operation of operations) {
      this.#byId.set(operation.id, operation);
      if (operation.command) this.#byCommand.set(operation.command, operation);
      const segments = parseTemplate(operation.path);
      this.#routes.push({
        operation, segments, literals: segments.filter(s => "literal" in s).length,
      });
      this.#tokens.set(operation.id, tokenize(
        `${operation.command ?? ""} ${operation.summary} ${operation.path} ${operation.product}`,
      ));
    }
    // A concrete path can fit two templates (`/zones/{id}/settings/{name}` and
    // `/zones/{id}/settings/ssl`); the one with more literal segments is the specific one.
    this.#routes.sort((a, b) => b.literals - a.literals);
  }

  get size(): number { return this.#byId.size; }

  /** Every operation, in index order. */
  all(): IterableIterator<ApiOperation> { return this.#byId.values(); }

  /** Finds an operation by `operationId` or unique command name. */
  get(idOrCommand: string): ApiOperation | undefined {
    return this.#byId.get(idOrCommand) ?? this.#byCommand.get(idOrCommand);
  }

  /** Loads the detail for one operation. */
  schema(id: string): ApiOperationSchema {
    this.#schemas ??= this.#loadSchemas();
    return this.#schemas[id] ?? { params: [] };
  }

  /** Resolves a method and concrete path to the operation that serves it. */
  resolve(method: string, path: string): ResolvedRequest | undefined {
    const upper = method.toUpperCase();
    const parts = splitConcretePath(path);
    for (const route of this.#routes) {
      if (route.operation.method !== upper || route.segments.length !== parts.length) continue;
      const pathParams: Record<string, string> = {};
      const matched = route.segments.every((segment, i) => {
        if ("literal" in segment) return segment.literal === parts[i];
        pathParams[segment.param] = parts[i]!;
        return true;
      });
      if (matched) return { operation: route.operation, pathParams };
    }
    return undefined;
  }

  /** The GET operation on the same path template, used to read state before a change. */
  readerFor(operation: ApiOperation): ApiOperation | undefined {
    if (operation.method === "GET") return undefined;
    for (const route of this.#routes) {
      if (route.operation.method === "GET" && route.operation.path === operation.path) {
        return route.operation;
      }
    }
    return undefined;
  }

  /**
   * Ranks operations by how many query terms their command, summary, path and product contain.
   * `filter` runs first, so a narrowed binding never sees, or is limited by, operations it cannot
   * call.
   */
  search(query: string, options: {
    limit?: number;
    filter?: (operation: ApiOperation) => boolean;
  } = {}): ApiOperation[] {
    if (query.length > MAX_SEARCH_QUERY) {
      throw new Error(`Search queries are limited to ${MAX_SEARCH_QUERY} characters.`);
    }
    const terms = tokenize(query);
    if (terms.length === 0) throw new Error("Search needs at least one word.");
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
    const scored: Array<{ operation: ApiOperation; score: number }> = [];
    for (const operation of this.#byId.values()) {
      if (options.filter && !options.filter(operation)) continue;
      const tokens = this.#tokens.get(operation.id)!;
      let score = 0;
      for (const term of terms) {
        if (tokens.includes(term)) score += 3;
        else if (tokens.some(token => token.startsWith(term))) score += 1;
      }
      if (score === 0) continue;
      // Prefer the live, shorter operation when the match is otherwise equal.
      if (operation.deprecated) score -= 2;
      scored.push({ operation, score: score - operation.path.length / 1000 });
    }
    scored.sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id));
    return scored.slice(0, limit).map(entry => entry.operation);
  }
}

/** Fills a path template, percent-encoding each parameter. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`Missing path parameter "${name}".`);
    if (value === "." || value === ".." || value.includes("/")) {
      throw new Error(`Path parameter "${name}" may not be "." or ".." or contain "/".`);
    }
    return encodeURIComponent(value);
  });
}
