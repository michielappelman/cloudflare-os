// Durable lifecycle for approval-gated Cloudflare API calls, in the gatekeeper's own SQLite.
//
// Modeled on the MCP gatekeeper's action store: the request is stored exactly as it will be sent
// (the body as serialized text), a claim is persisted before the request goes out, and a claim
// found by a fresh activation is failed rather than replayed, since the change may have landed.

import type { ApiQueryValue } from "./api-client.js";

/** One staged change and what happened to it. */
export interface StoredApiAction {
  id: number;
  operationId: string;
  pathParams: Record<string, string>;
  query?: Record<string, ApiQueryValue>;
  /** The JSON body exactly as it will be sent. */
  bodyText?: string;
  state: "pending" | "applying" | "applied" | "rejected" | "failed";
  submittedAt: number;
  /**
   * Digest of the resource as read when the change was requested, for operations that change one
   * existing resource. Apply refuses if the resource has changed since.
   */
  beforeDigest?: string;
  /** Whether a failed action may be approved again. */
  retryable?: boolean;
  /** The redacted response, as JSON text. */
  resultJson?: string;
  resultInfoJson?: string;
  error?: string;
}

type ActionRow = {
  id: number;
  operation_id: string;
  path_params_json: string;
  query_json: string | null;
  body_text: string | null;
  state: StoredApiAction["state"];
  submitted_at: number;
  before_digest: string | null;
  retryable: number | null;
  result_json: string | null;
  result_info_json: string | null;
  error: string | null;
};

const MAX_PENDING_ACTIONS = 50;
const MAX_RETAINED_ACTIONS = 200;
/** Largest response kept for `getActionResult()`. */
export const MAX_RESULT_BYTES = 128 * 1024;
const MAX_ERROR_LENGTH = 2048;

/** Reported for a claim an earlier activation never finished. */
export const OUTCOME_UNKNOWN_MESSAGE =
  "This change was interrupted after it had been sent to Cloudflare, so it may or may not have " +
  "taken effect. Check the resource before requesting it again.";

function fromRow(row: ActionRow): StoredApiAction {
  return {
    id: row.id,
    operationId: row.operation_id,
    pathParams: JSON.parse(row.path_params_json) as Record<string, string>,
    ...(row.query_json ? { query: JSON.parse(row.query_json) as Record<string, ApiQueryValue> } : {}),
    ...(row.body_text !== null ? { bodyText: row.body_text } : {}),
    state: row.state,
    submittedAt: row.submitted_at,
    ...(row.before_digest ? { beforeDigest: row.before_digest } : {}),
    ...(row.retryable !== null ? { retryable: row.retryable === 1 } : {}),
    ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
    ...(row.result_info_json !== null ? { resultInfoJson: row.result_info_json } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

/** Stores staged API calls in one SQLite table. */
export class ApiActionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS cf_api_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL,
      path_params_json TEXT NOT NULL CHECK (json_valid(path_params_json)),
      query_json TEXT CHECK (query_json IS NULL OR json_valid(query_json)),
      body_text TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'rejected', 'failed')),
      submitted_at INTEGER NOT NULL,
      before_digest TEXT,
      retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
      result_json TEXT,
      result_info_json TEXT,
      error TEXT
    ) STRICT`);
    sql.exec(
      `UPDATE cf_api_actions SET state = 'failed', retryable = 0, error = ? WHERE state = 'applying'`,
      OUTCOME_UNKNOWN_MESSAGE,
    );
  }

  get(id: number): StoredApiAction | undefined {
    const row = this.#sql.exec<ActionRow>("SELECT * FROM cf_api_actions WHERE id = ?", id).toArray()[0];
    return row && fromRow(row);
  }

  /** Records a change awaiting a decision. */
  stage(action: Pick<StoredApiAction, "operationId" | "pathParams" | "query" | "bodyText" | "beforeDigest">):
      StoredApiAction {
    const { count } = this.#sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM cf_api_actions WHERE state IN ('pending', 'applying')",
    ).one();
    if (count >= MAX_PENDING_ACTIONS) {
      throw new Error(`${MAX_PENDING_ACTIONS} Cloudflare changes are already waiting for the ` +
        "user. Wait for them to be decided before requesting more.");
    }
    const submittedAt = Date.now();
    const { id } = this.#sql.exec<{ id: number }>(
      `INSERT INTO cf_api_actions
         (operation_id, path_params_json, query_json, body_text, state, submitted_at, before_digest)
       VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
      action.operationId,
      JSON.stringify(action.pathParams),
      action.query ? JSON.stringify(action.query) : null,
      action.bodyText ?? null,
      submittedAt,
      action.beforeDigest ?? null,
    ).one();
    return { ...action, id, state: "pending", submittedAt };
  }

  /** Drops a staged action whose submission to the approval queue failed. */
  discard(id: number): void {
    this.#sql.exec("DELETE FROM cf_api_actions WHERE id = ? AND state = 'pending'", id);
  }

  /**
   * Claims a decided action for applying. Returns undefined when it was already applied (a repeat
   * approval is a no-op), and throws when it cannot be applied.
   */
  claim(id: number): StoredApiAction | undefined {
    const stored = this.get(id);
    if (!stored) throw new Error(`Cloudflare API action ${id} is unknown.`);
    switch (stored.state) {
      case "applied": return undefined;
      case "rejected": throw new Error(`Cloudflare API action ${id} was already rejected.`);
      case "applying": throw new Error(`Cloudflare API action ${id} is already being applied.`);
      case "failed":
        if (stored.retryable === false) {
          throw new Error(stored.error ?? `Cloudflare API action ${id} cannot be retried.`);
        }
    }
    this.#sql.exec(
      "UPDATE cf_api_actions SET state = 'applying', error = NULL, retryable = NULL WHERE id = ?", id,
    );
    return { ...stored, state: "applying" };
  }

  /** Records a successful apply. */
  succeed(id: number, resultJson: string, resultInfoJson?: string): void {
    const kept = new TextEncoder().encode(resultJson).byteLength > MAX_RESULT_BYTES
      ? JSON.stringify(`(The response was too large to keep: ${resultJson.length} characters.)`)
      : resultJson;
    this.#sql.exec(
      `UPDATE cf_api_actions SET state = 'applied', result_json = ?, result_info_json = ? WHERE id = ?`,
      kept, resultInfoJson ?? null, id,
    );
    this.#prune();
  }

  /**
   * Records a failed apply. `retryable` is true only when the change is known not to have landed
   * and approving it again could still succeed.
   */
  fail(id: number, message: string, retryable: boolean): void {
    this.#sql.exec(
      "UPDATE cf_api_actions SET state = 'failed', retryable = ?, error = ? WHERE id = ?",
      retryable ? 1 : 0, message.slice(0, MAX_ERROR_LENGTH), id,
    );
    this.#prune();
  }

  /** Records a rejection. A failed action stays failed but can no longer be retried. */
  reject(id: number): void {
    const stored = this.get(id);
    if (!stored || stored.state === "rejected") return;
    if (stored.state === "failed") {
      this.#sql.exec("UPDATE cf_api_actions SET retryable = 0 WHERE id = ?", id);
      return;
    }
    if (stored.state !== "pending") {
      throw new Error(`Cloudflare API action ${id} is already ${stored.state}.`);
    }
    this.#sql.exec("UPDATE cf_api_actions SET state = 'rejected' WHERE id = ?", id);
    this.#prune();
  }

  #prune(): void {
    this.#sql.exec(`DELETE FROM cf_api_actions WHERE id IN (
      SELECT id FROM cf_api_actions WHERE state NOT IN ('pending', 'applying')
      ORDER BY id DESC LIMIT -1 OFFSET ${MAX_RETAINED_ACTIONS}
    )`);
  }
}
