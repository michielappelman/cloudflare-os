import { Tooltip } from "@cloudflare/kumo";
import { ArrowsSplit } from "@phosphor-icons/react";
import type { AiModelRouting } from "@gadgets/workshop-shared/api";

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
 * Which model(s) AI Gateway's Auto Router picked for the requests behind one transcript row, with
 * each request's model, routing reason, token counts and timing on hover. Renders nothing when
 * no request was routed.
 */
export function RoutedModelBadge({ routings }: { routings: readonly AiModelRouting[] }) {
  if (routings.length === 0) return null;
  const summary = summarizeRoutedModels(routings);
  return (
    <Tooltip content={<RoutingDetails routings={routings} />} asChild>
      <button
        type="button"
        className="-ml-0.5 flex max-w-full cursor-default items-center gap-1 rounded-md px-0.5 text-[11px] leading-4 text-kumo-inactive transition-colors hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
        aria-label={`Routed to ${summary.map(({ model }) => model).join(", ")}`}
      >
        <ArrowsSplit size={12} className="shrink-0" aria-hidden="true" />
        <span className="truncate">
          {summary.map(({ model, count }, i) => (
            <span key={model}>
              {i > 0 && " · "}
              <span className="font-mono">{shortModelName(model)}</span>
              {count > 1 && <span className="opacity-70"> ×{count}</span>}
            </span>
          ))}
        </span>
      </button>
    </Tooltip>
  );
}
