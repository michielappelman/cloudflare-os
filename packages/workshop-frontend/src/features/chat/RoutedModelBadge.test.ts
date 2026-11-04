import { describe, expect, it } from "vitest";
import type { AiModelRouting } from "@gadgets/workshop-shared/api";
import { describeRoutingReason, shortModelName, summarizeRoutedModels } from "./RoutedModelBadge";

function routed(model: string): AiModelRouting {
  return { model, reason: "cost_optimal_within_pool" };
}

describe("RoutedModelBadge helpers", () => {
  it("summarizes distinct models in order of first use", () => {
    expect(summarizeRoutedModels([
      routed("openai/gpt-6-luna"), routed("anthropic/claude-sonnet-5-5"),
      routed("openai/gpt-6-luna"),
    ])).toEqual([
      { model: "openai/gpt-6-luna", count: 2 },
      { model: "anthropic/claude-sonnet-5-5", count: 1 },
    ]);
  });

  it("carries the display name recorded with a model, if any request has one", () => {
    expect(summarizeRoutedModels([
      routed("anthropic/claude-haiku-5.5"),
      { ...routed("anthropic/claude-haiku-5.5"), name: "Haiku 5.5" },
      routed("openai/gpt-6-luna"),
    ])).toEqual([
      { model: "anthropic/claude-haiku-5.5", name: "Haiku 5.5", count: 2 },
      { model: "openai/gpt-6-luna", count: 1 },
    ]);
  });

  it("labels known routing reasons and passes unknown ones through", () => {
    expect(describeRoutingReason("pinned_by_turn")).toBe("Pinned for this turn");
    expect(describeRoutingReason("something_new")).toBe("something_new");
    expect(describeRoutingReason(undefined)).toBe("Reason not reported");
  });

  it("drops the provider prefix", () => {
    expect(shortModelName("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(shortModelName("@cf/zai-org/glm-5.2")).toBe("zai-org/glm-5.2");
    expect(shortModelName("plain")).toBe("plain");
  });
});
