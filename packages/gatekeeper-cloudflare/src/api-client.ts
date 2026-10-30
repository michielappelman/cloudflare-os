// The one place the API resource talks HTTP. Requests are built only from a catalog operation and
// its parameters, so the URL is always `api.cloudflare.com/client/v4` plus a known path template.

import { fillPath, type ApiOperation } from "./api-spec.js";

const API_BASE = "https://api.cloudflare.com/client/v4";
/** Largest response body read, in bytes of text. Bigger answers need filters or pagination. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Largest JSON request body sent. */
export const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_QUERY_PARAMS = 50;

/** A query parameter value. Arrays repeat the key, as Cloudflare's list filters expect. */
export type ApiQueryValue = string | number | boolean | Array<string | number | boolean>;

/** A request with its parameters split by location. */
export interface ApiCallParams {
  pathParams: Record<string, string>;
  query?: Record<string, ApiQueryValue>;
  body?: unknown;
}

/** A successful response. `result` is the envelope's `result`, or the whole body when there is none. */
export interface ApiResponse {
  status: number;
  result: unknown;
  resultInfo?: Record<string, unknown>;
}

/**
 * A failed call. `message` may quote the caller's own input back (Cloudflare echoes invalid values),
 * so it goes to the caller who caused it and never to logs; `codes` are what is logged.
 */
export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly codes: readonly number[] = [],
    /** Whether `message` came from Cloudflare (and so may carry caller text). */
    readonly fromProvider = false,
  ) {
    super(message);
  }
}

/**
 * Whether a failure proves the request did not take effect. A response with a 4xx status was
 * refused; anything else -- a 5xx, a dropped connection -- may have landed.
 */
export function provesNotApplied(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status >= 400 && error.status < 500;
}

function encodeQuery(query: Record<string, ApiQueryValue> | undefined): string {
  if (!query) return "";
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_PARAMS) throw new Error("Too many query parameters.");
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!["string", "number", "boolean"].includes(typeof item)) {
        throw new Error(`Query parameter "${key}" must be a string, number, boolean or array of them.`);
      }
      params.append(key, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Serializes a JSON request body once, so what is approved is byte-for-byte what is sent. */
export function encodeBody(operation: ApiOperation, body: unknown): string | undefined {
  if (body === undefined) {
    if (operation.bodyRequired) throw new Error(`${operation.id} requires a request body.`);
    return undefined;
  }
  if (!operation.body) throw new Error(`${operation.id} takes no request body.`);
  if (operation.body !== "json") {
    throw new Error(`${operation.id} takes a ${operation.body} body, which this connection ` +
      "cannot send yet.");
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    throw new Error("The request body must be JSON-serializable.");
  }
  if (text === undefined) throw new Error("The request body must be JSON-serializable.");
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new Error(`The request body is larger than ${MAX_REQUEST_BYTES} bytes.`);
  }
  return text;
}

function providerFailure(status: number, body: unknown): CloudflareApiError {
  const errors = (body as { errors?: unknown })?.errors;
  const list = Array.isArray(errors) ? errors as Array<{ code?: unknown; message?: unknown }> : [];
  const codes = list.map(e => e?.code).filter((c): c is number => typeof c === "number");
  const messages = list.map(e => e?.message).filter((m): m is string => typeof m === "string");
  return messages.length > 0
    ? new CloudflareApiError(status, `Cloudflare API error ${status}: ${messages.join("; ")}`, codes, true)
    : new CloudflareApiError(status, `Cloudflare API request failed with status ${status}.`, codes);
}

/** Sends catalog operations with the connection's access token. */
export class CloudflareApiClient {
  readonly #getToken: () => Promise<string | null>;
  readonly #fetch: typeof fetch;

  constructor(getToken: () => Promise<string | null>, fetcher: typeof fetch = fetch) {
    this.#getToken = getToken;
    this.#fetch = fetcher;
  }

  /** The URL a call goes to; also what an approval shows. */
  static url(operation: ApiOperation, params: Pick<ApiCallParams, "pathParams" | "query">): string {
    return API_BASE + fillPath(operation.path, params.pathParams) + encodeQuery(params.query);
  }

  /** Sends one request. `bodyText` comes from `encodeBody`. */
  async send(operation: ApiOperation, params: ApiCallParams, bodyText?: string): Promise<ApiResponse> {
    if (operation.response === "binary") {
      throw new CloudflareApiError(400, `${operation.id} returns binary data, which this ` +
        "connection does not read.");
    }
    const url = CloudflareApiClient.url(operation, params);
    const token = await this.#getToken();
    if (!token) {
      throw new CloudflareApiError(401, "The Cloudflare connection has expired. Reconnect it in " +
        "Cloudflare OS and try again.");
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (bodyText !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.#fetch(url, { method: operation.method, headers, body: bodyText });

    const declared = Number(response.headers.get("Content-Length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new CloudflareApiError(413, "The response is too large to return. Narrow it with " +
        "filters or pagination.");
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new CloudflareApiError(413, "The response is too large to return. Narrow it with " +
        "filters or pagination.");
    }

    const isJson = (response.headers.get("Content-Type") ?? "").includes("json");
    let parsed: unknown = undefined;
    if (isJson && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CloudflareApiError(502, "Cloudflare returned malformed JSON.");
      }
    }

    if (!response.ok) throw providerFailure(response.status, parsed);
    if (parsed === undefined) {
      return { status: response.status, result: text === "" ? null : text };
    }
    const envelope = parsed as {
      success?: unknown; result?: unknown; result_info?: unknown; errors?: unknown;
    };
    if (typeof envelope === "object" && envelope !== null && "success" in envelope) {
      if (envelope.success === false) throw providerFailure(response.status, envelope);
      const info = envelope.result_info;
      return {
        status: response.status,
        result: envelope.result ?? null,
        ...(info && typeof info === "object" ? { resultInfo: info as Record<string, unknown> } : {}),
      };
    }
    return { status: response.status, result: parsed };
  }
}
