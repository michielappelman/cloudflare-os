import { Tooltip } from "@cloudflare/kumo";
import { ArrowsSplit } from "@phosphor-icons/react";
import { SUGGESTED_MODELS, type AiChatAuthorInfo, type AiModelRouting } from "@gadgets/workshop-shared/api";

// Plain-language labels for AI Gateway's cf-aig-routing-reason values.
// https://developers.cloudflare.com/ai-gateway/features/auto-router/#routing-reasons
const ROUTING_REASONS: Record<string, string> = {
  cost_optimal_within_pool: "Best quality for the cost",
  forced_by_candidate_pool: "Only eligible model",
  pinned_by_turn: "Pinned for this turn",
  fallback_candidate_unavailable: "Fallback: chosen model unavailable",
  fallback_key_not_in_candidates: "Fallback: invalid routing decision",
  fallback_router_error: "Fallback: router error",
  fallback_router_timeout: "Fallback: router timed out",
  fallback_unsupported_input: "Fallback: no text to classify",
};

// Requests listed in the tooltip; a long agent run keeps its most recent ones.
const MAX_LISTED_REQUESTS = 12;

/** A routing reason in plain language; unknown values pass through verbatim. */
export function describeRoutingReason(reason: string | undefined): string {
  if (!reason) return "Reason not reported";
  return ROUTING_REASONS[reason] ?? reason;
}

/** "anthropic/claude-sonnet-5-5" -> "claude-sonnet-5-5". */
export function shortModelName(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/** The models a name can come from: the chat's model list (`listModels()`), by ID. */
export type ModelNames = readonly Pick<AiChatAuthorInfo, "id" | "name">[];

/**
 * A routed model's display name. The router reports `provider/model-id`; the model ID is the one
 * the chat's model list and SUGGESTED_MODELS key models by, up to its separators (see
 * comparableModelId). The list comes first, so an admin's own
 * name for a model wins; the catalog covers models the list leaves out (hidden or disabled ones
 * the router can still pick); an unknown model shows its ID.
 */
export function routedModelName(model: string, models: ModelNames): string {
  const id = shortModelName(model);
  const key = comparableModelId(id);
  const offered = models.find((entry) => comparableModelId(entry.id) === key);
  if (offered) return offered.name;
  for (const catalog of Object.values(SUGGESTED_MODELS)) {
    for (const [catalogId, entry] of Object.entries(catalog)) {
      if (comparableModelId(catalogId) === key) return entry.name;
    }
  }
  return id;
}

/**
 * A model ID with separators made uniform. The router reports versions with dots
 * ("claude-sonnet-5.5") where provider APIs and the catalog use dashes ("claude-sonnet-5-5").
 */
function comparableModelId(id: string): string {
  return id.toLowerCase().replace(/[._]/g, "-");
}

/** Distinct routed models in order of first use, with how many requests each served. */
export function summarizeRoutedModels(
  routings: readonly AiModelRouting[],
): { model: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { model } of routings) counts.set(model, (counts.get(model) ?? 0) + 1);
  return [...counts].map(([model, count]) => ({ model, count }));
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatStats(routing: AiModelRouting): string {
  const parts: string[] = [];
  if (routing.inputTokens !== undefined) parts.push(`${formatTokens(routing.inputTokens)} in`);
  if (routing.outputTokens !== undefined) parts.push(`${formatTokens(routing.outputTokens)} out`);
  if (routing.durationMs !== undefined) parts.push(`${(routing.durationMs / 1000).toFixed(1)} s`);
  return parts.join(" · ");
}

function RoutingDetails({ routings }: { routings: readonly AiModelRouting[] }) {
  const listed = routings.slice(-MAX_LISTED_REQUESTS);
  const firstIndex = routings.length - listed.length;
  return (
    <div className="max-w-[340px] space-y-2 py-0.5 text-left">
      <div className="font-medium">
        Auto Router · {routings.length} {routings.length === 1 ? "request" : "requests"}
      </div>
      {firstIndex > 0 && (
        <div className="opacity-70">{firstIndex} earlier not shown</div>
      )}
      <ol className="space-y-1.5">
        {listed.map((routing, i) => {
          const stats = formatStats(routing);
          return (
            <li key={firstIndex + i}>
              <div>
                <span className="opacity-60">#{firstIndex + i + 1}</span>{" "}
                <span className="font-mono">{routing.model}</span>
              </div>
              <div className="opacity-80">{describeRoutingReason(routing.reason)}</div>
              {stats && <div className="opacity-70">{stats}</div>}
              {routing.decisionId && (
                <div className="truncate font-mono text-[10px] opacity-50">
                  decision {routing.decisionId}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Which model(s) AI Gateway's Auto Router picked for the requests behind one transcript row, by
 * display name, with each request's exact model ID, routing reason, token counts and timing on
 * hover. Renders nothing when no request was routed.
 */
export function RoutedModelBadge({ routings, models }: {
  routings: readonly AiModelRouting[];
  models: ModelNames;
}) {
  if (routings.length === 0) return null;
  const summary = summarizeRoutedModels(routings);
  return (
    <Tooltip content={<RoutingDetails routings={routings} />} asChild>
      <button
        type="button"
        className="-ml-0.5 flex max-w-full cursor-default items-center gap-1 rounded-md px-0.5 text-[11px] leading-4 text-kumo-inactive transition-colors hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
        aria-label={`Routed to ${summary.map(({ model }) => routedModelName(model, models)).join(", ")}`}
      >
        <ArrowsSplit size={12} className="shrink-0" aria-hidden="true" />
        <span className="truncate">
          {summary.map(({ model, count }, i) => (
            <span key={model}>
              {i > 0 && " · "}
              <span>{routedModelName(model, models)}</span>
              {count > 1 && <span className="opacity-70"> ×{count}</span>}
            </span>
          ))}
        </span>
      </button>
    </Tooltip>
  );
}
