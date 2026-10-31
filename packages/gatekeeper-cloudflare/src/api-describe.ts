// What the approval queue records for Cloudflare API calls. An approver reads these to decide, so
// every value that will be sent (path parameters, query, body) is shown verbatim as a field, and
// names Cloudflare chose (zone names) only ever appear in fields too.

import {
  buildDescription, codeSpan, plainInline, sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { ApiQueryValue } from "./api-client.js";
import type { ApiOperation } from "./api-spec.js";
import { actionKindTag, type ApiTier } from "./api-tiers.js";

/** A call as the description needs it. */
export interface DescribedCall {
  operation: ApiOperation;
  tier: ApiTier;
  /** The full request URL, query included. */
  url: string;
  pathParams: Record<string, string>;
  query?: Record<string, ApiQueryValue>;
  bodyText?: string;
  /** The zone the call targets, when it targets one. */
  zone?: { id: string; name: string };
  /** The binding's own label, e.g. `account 0123…` or `zone example.com`. */
  target: string;
}

const TIER_NOTES: Record<Exclude<ApiTier, "read" | "blocked">, string> = {
  write: "",
  destructive: "This change deletes or overwrites data, or Cloudflare marks it as irreversible.",
  privileged: "This change affects identity, credentials, membership or billing.",
};

function title(call: DescribedCall): string {
  return sanitizeTitle(`Cloudflare: ${call.operation.summary}`);
}

/** The observation recorded when a read's data is returned. */
export function describeRead(call: DescribedCall, summary: string): ObservationDescription {
  const built = buildDescription(
    `Read ${codeSpan(call.operation.command ?? call.operation.id)} ` +
    `(${call.operation.method} ${codeSpan(call.operation.path)}) on the Cloudflare ${call.target}; ` +
    `${summary}.`,
  ).inline("Request", `${call.operation.method} ${call.url}`);
  if (call.zone) built.inline("Zone", call.zone.name);
  const { description, fields } = built.finish();
  return { title: title(call), description, ...(fields ? { fields } : {}) };
}

// Field names that say which resource a call is about, in the order they are tried. Covers most
// Cloudflare resources: DNS records (name), routes (pattern), hostnames, rules (description), etc.
const LABEL_KEYS = ["name", "pattern", "hostname", "title", "description", "script", "domain", "id"];
// Fields Cloudflare maintains itself; a PUT that leaves them out does not reset them.
const SERVER_FIELDS = /^(id|tag|created(_on|_at)?|modified(_on|_at)?|updated(_on|_at)?|etag|meta|zone_id|zone_name|account_id|status|version)$/;
const MAX_CHANGES = 40;
const MAX_VALUE = 100;

const VERBS: Record<string, string> = {
  DELETE: "Deletes", POST: "Creates or runs", PUT: "Replaces", PATCH: "Updates",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One short, single-line rendering of a value for a change list. */
function brief(value: unknown): string {
  const text = value === undefined ? "(unset)" : JSON.stringify(value) ?? String(value);
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE - 1)}…` : flat;
}

/** A human label for the resource, from the request body or the current state. */
export function resourceLabel(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    // A DNS-style record reads best as "A www.example.com".
    if (typeof source.type === "string" && typeof source.name === "string" && source.type.length <= 10) {
      return `${source.type} ${source.name}`;
    }
    for (const key of LABEL_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Flattens objects to `a.b` keys (two levels), leaving arrays and scalars as values. */
function flatten(value: Record<string, unknown>, prefix = "", depth = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(inner) && depth < 1 && Object.keys(inner).length > 0) {
      for (const [k, v] of flatten(inner, path, depth + 1)) out.set(k, v);
    } else {
      out.set(path, inner);
    }
  }
  return out;
}

/**
 * Field-by-field changes, as single-line list items: `field: old → new` against the current state,
 * or `field: value` for a creation. A summary only; the full body and state are shown as well.
 */
export function changeList(method: string, body: unknown, before: unknown): string[] {
  if (!isRecord(body)) return [];
  const proposed = flatten(body);
  const items: string[] = [];
  if (!isRecord(before)) {
    for (const [key, value] of proposed) items.push(`${key}: ${brief(value)}`);
  } else {
    const current = flatten(before);
    for (const [key, value] of proposed) {
      if (JSON.stringify(current.get(key)) !== JSON.stringify(value)) {
        items.push(`${key}: ${brief(current.get(key))} → ${brief(value)}`);
      }
    }
    if (method === "PUT") {
      for (const [key, value] of current) {
        const top = key.split(".")[0]!;
        if (!proposed.has(key) && !(top in body) && !SERVER_FIELDS.test(top)) {
          items.push(`${key}: ${brief(value)} → (not in request; may be reset)`);
        }
      }
    }
  }
  if (items.length > MAX_CHANGES) {
    return [...items.slice(0, MAX_CHANGES), `… and ${items.length - MAX_CHANGES} more (see the request body)`];
  }
  return items;
}

/**
 * The approval for a change. `before` is the resource as read when the change was requested, for
 * changes to one existing resource. The description leads with what changes in plain terms (a
 * named resource and a field-by-field list), then the request exactly as it will be sent.
 */
export function describeChange(call: DescribedCall, before?: unknown): ActionDescription {
  const { operation, tier } = call;
  const body: unknown = call.bodyText !== undefined ? JSON.parse(call.bodyText) : undefined;
  const label = resourceLabel(body, before);
  const where = call.zone ? `zone ${plainInline(call.zone.name)}` : `the Cloudflare ${call.target}`;
  const what = operation.summary.replace(/^\S+\s+/, "").toLowerCase();
  const verb = VERBS[operation.method] ?? "Changes";

  const intro = [
    `**${verb} ${what}${label ? ` ${codeSpan(label)}` : ""}** in ${where}.`,
    tier !== "read" && tier !== "blocked" ? TIER_NOTES[tier] : "",
    operation.confirm ? `Cloudflare warns: ${codeSpan(operation.confirm, 200)}` : "",
    before !== undefined
      ? "If the resource changes before this is approved, the change will not be made."
      : "",
    `Operation: ${codeSpan(operation.command ?? operation.id)}.`,
  ].filter(Boolean).join(" ");

  const built = buildDescription(intro);
  const changes = changeList(operation.method, body, before);
  if (changes.length > 0) built.list(isRecord(before) ? "Changes" : "New values", changes);
  if (call.zone) built.inline("Zone", call.zone.name);
  if (body !== undefined) built.json("Request body", body);
  if (before !== undefined) {
    built.json(operation.method === "DELETE" ? "Being deleted" : "Current state", before);
  }
  built.inline("Request", `${operation.method} ${call.url}`);
  for (const [name, value] of Object.entries(call.pathParams)) built.inline(`Path: ${name}`, value);
  if (call.query && Object.keys(call.query).length > 0) built.json("Query", call.query);
  const rendered = built.finish();

  const autoApprovable = tier === "write";
  return {
    // A title is plain text, not Markdown, so the label stays exact (a route's `*` included);
    // sanitizeTitle flattens it to one line and caps it.
    title: sanitizeTitle(`${operation.summary}${label ? `: ${label}` : ""}` +
      (call.zone ? ` (${call.zone.name})` : "")),
    ...rendered,
    implementsRevert: false,
    // Nothing about a pending change is simulated: reads show Cloudflare's current state, so an
    // agent that kept going would act as if the change had not been requested.
    awaitDecision: true,
    ...(autoApprovable
      ? {
          autoApprovable: true,
          actionKind: { tag: actionKindTag(operation.product), label: productLabel(operation.product) },
        }
      : {}),
  };
}

/** The auto-approval label for ordinary changes to one product. */
export function productLabel(product: string): string {
  return `Change ${product} configuration (Cloudflare API)`;
}

/** The observation recorded when a GraphQL Analytics query's data is returned. */
export function describeGraphqlRead(target: string, query: string, variables: Record<string, unknown>,
    zones: readonly string[], summary: string): ObservationDescription {
  const built = buildDescription(
    `Ran a GraphQL Analytics query on the Cloudflare ${target}; ${summary}.`,
  ).verbatim("Query", query);
  if (Object.keys(variables).length > 0) built.json("Variables", variables);
  if (zones.length > 0) built.list("Zones", zones);
  const { description, fields } = built.finish();
  return { title: "Cloudflare: GraphQL Analytics query", description, ...(fields ? { fields } : {}) };
}
