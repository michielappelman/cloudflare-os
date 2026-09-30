// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  AiChatMessage, AiChatMessageBody, AiModelRouting, AiToolCall,
} from "@gadgets/workshop-shared/api";
import { buildChatDisplayEntries } from "./ChatInterface";
import { describeRoutingReason, shortModelName, summarizeRoutedModels } from "./RoutedModelBadge";

const AUTHOR = { type: "agent", id: "cloudflare/auto", name: "Auto Router" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

function routed(model: string): AiModelRouting {
  return { model, reason: "cost_optimal_within_pool" };
}

const TOOL_CALL: AiToolCall = { toolCallId: "t", toolName: "executeCode", input: { code: "" } };

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

describe("buildChatDisplayEntries routing", () => {
  it("collects every folded request's routing onto its row, oldest first", () => {
    const entries = buildChatDisplayEntries([
      message(1, { type: "message", message: "", toolCalls: [TOOL_CALL],
                   routing: routed("openai/gpt-6-luna") }),
      message(2, { type: "message", message: "", toolCalls: [TOOL_CALL],
                   routing: routed("openai/gpt-6-luna") }),
      message(3, { type: "message", message: "Done.",
                   routing: routed("anthropic/claude-sonnet-5-5") }),
    ], new Map());

    expect(entries.map(entry => ({
      type: entry.type,
      models: "routings" in entry ? entry.routings?.map(r => r.model) : undefined,
    }))).toEqual([
      { type: "workRun", models: ["openai/gpt-6-luna", "openai/gpt-6-luna"] },
      { type: "message", models: ["anthropic/claude-sonnet-5-5"] },
    ]);
  });

  it("leaves rows of unrouted models untouched", () => {
    const [entry] = buildChatDisplayEntries(
        [message(1, { type: "message", message: "Hi." })], new Map());
    expect(entry).not.toHaveProperty("routings");
  });
});
