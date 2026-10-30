// What the approval queue records for Cloudflare API calls. An approver reads these to decide, so
// every value that will be sent (path parameters, query, body) is shown verbatim as a field, and
// names Cloudflare chose (zone names) only ever appear in fields too.

import {
  buildDescription, codeSpan, sanitizeTitle,
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

/**
 * The approval for a change. `before` is the resource as read when the change was requested, for
 * changes to one existing resource; it is shown so the approver sees what is being replaced.
 */
export function describeChange(call: DescribedCall, before?: unknown): ActionDescription {
  const { operation, tier } = call;
  const intro = [
    `Calls ${codeSpan(operation.command ?? operation.id)} ` +
    `(${operation.method} ${codeSpan(operation.path)}) on the Cloudflare ${call.target}.`,
    tier !== "read" && tier !== "blocked" ? TIER_NOTES[tier] : "",
    operation.confirm ? `Cloudflare warns: ${codeSpan(operation.confirm, 200)}` : "",
    before !== undefined
      ? "If the resource changes before this is approved, the change will not be made."
      : "",
  ].filter(Boolean).join(" ");

  const built = buildDescription(intro)
    .inline("Request", `${operation.method} ${call.url}`);
  if (call.zone) built.inline("Zone", call.zone.name);
  for (const [name, value] of Object.entries(call.pathParams)) built.inline(`Path: ${name}`, value);
  if (call.query && Object.keys(call.query).length > 0) built.json("Query", call.query);
  if (call.bodyText !== undefined) built.json("Request body", JSON.parse(call.bodyText));
  if (before !== undefined) built.json("Current state", before);
  const rendered = built.finish();

  const autoApprovable = tier === "write";
  return {
    title: title(call),
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
