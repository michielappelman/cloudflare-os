import { Popover } from "@cloudflare/kumo";
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

// Requests listed in the details; a long agent run keeps its most recent ones.
const MAX_LISTED_REQUESTS = 12;

/** A routing reason in plain language; unknown values pass through verbatim. */
export const describeRoutingReason = (reason: string | undefined): string =>
  reason ? (ROUTING_REASONS[reason] ?? reason) : "Reason not reported";

/** "anthropic/claude-sonnet-5-5" -> "claude-sonnet-5-5". */
export const shortModelName = (model: string): string => {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
};

/**
 * Distinct routed models in order of first use, with how many requests each served and the
 * display name recorded with them, if any request has one.
 */
export const summarizeRoutedModels = (
  routings: readonly AiModelRouting[],
): { model: string; name?: string; count: number }[] => {
  const seen = new Map<string, { model: string; name?: string; count: number }>();
  for (const { model, name } of routings) {
    const entry = seen.get(model);
    if (entry) {
      entry.count++;
      entry.name ??= name;
    } else {
      seen.set(model, { model, ...(name ? { name } : {}), count: 1 });
    }
  }
  return [...seen.values()];
};

const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

const formatStats = (routing: AiModelRouting): string => {
  const parts: string[] = [];
  if (routing.inputTokens !== undefined) parts.push(`${formatTokens(routing.inputTokens)} in`);
  if (routing.outputTokens !== undefined) parts.push(`${formatTokens(routing.outputTokens)} out`);
  if (routing.durationMs !== undefined) parts.push(`${(routing.durationMs / 1000).toFixed(1)} s`);
  return parts.join(" · ");
};

const RoutingDetails = ({ routings }: { routings: readonly AiModelRouting[] }) => {
  const listed = routings.slice(-MAX_LISTED_REQUESTS);
  const firstIndex = routings.length - listed.length;
  return (
    <div className="space-y-2 px-3.5 py-2.5 text-left text-[12px] leading-4">
      <Popover.Title className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Auto Router · {routings.length} {routings.length === 1 ? "request" : "requests"}
      </Popover.Title>
      {firstIndex > 0 && (
        <div className="text-kumo-inactive">{firstIndex} earlier not shown</div>
      )}
      <ol className="space-y-2">
        {listed.map((routing, i) => {
          const stats = formatStats(routing);
          return (
            <li key={firstIndex + i} className="space-y-0.5">
              <div className="flex items-baseline gap-1.5 text-kumo-default">
                <span className="text-kumo-inactive">#{firstIndex + i + 1}</span>
                <span className="font-medium">{routing.name ?? shortModelName(routing.model)}</span>
              </div>
              {routing.name && (
                <div className="break-all font-mono text-[11px] text-kumo-inactive">{routing.model}</div>
              )}
              <div className="text-kumo-subtle">{describeRoutingReason(routing.reason)}</div>
              {stats && <div className="text-kumo-subtle">{stats}</div>}
              {routing.decisionId && (
                <div className="truncate font-mono text-[10px] text-kumo-inactive">
                  decision {routing.decisionId}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/**
 * Which model(s) AI Gateway's Auto Router picked for the requests behind one transcript row, by the
 * display name recorded with them (else the model ID). Tapping or clicking it opens each request's
 * name and exact model, routing reason, token counts and timing. Renders nothing when no request
 * was routed.
 */
export const RoutedModelBadge = ({ routings }: { routings: readonly AiModelRouting[] }) => {
  if (routings.length === 0) return null;
  const summary = summarizeRoutedModels(routings);
  // A popover, not a tooltip: a tooltip opens on hover and focus only, which a phone has neither of.
  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="-ml-0.5 flex max-w-full cursor-pointer items-center gap-1 rounded-md px-0.5 text-[11px] leading-4 text-kumo-inactive transition-colors hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
            aria-label={`Routed to ${summary.map(({ model, name }) => name ?? model).join(", ")}; show routing details`}
          >
            <ArrowsSplit size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">
              {summary.map(({ model, name, count }, i) => (
                <span key={model}>
                  {i > 0 && " · "}
                  {name ? <span>{name}</span> : <span className="font-mono">{shortModelName(model)}</span>}
                  {count > 1 && <span className="opacity-70"> ×{count}</span>}
                </span>
              ))}
            </span>
          </button>
        }
      />
      {/* Kumo renders base-ui's arrow as the popup's first child; hidden, as in the Activity
          popover, so the panel sits flush. */}
      <Popover.Content
        side="top"
        align="start"
        sideOffset={6}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(340px,calc(100vw-24px))] !min-w-0 max-h-[min(420px,60vh)] overflow-y-auto rounded-lg border border-kumo-line !outline-none bg-kumo-base !p-0 [&>:first-child]:hidden"
      >
        <RoutingDetails routings={routings} />
      </Popover.Content>
    </Popover>
  );
};
