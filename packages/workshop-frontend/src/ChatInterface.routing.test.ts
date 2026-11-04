// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  AiChatMessage, AiChatMessageBody, AiModelRouting, AiToolCall,
} from "@gadgets/workshop-shared/api";
import { buildChatDisplayEntries } from "./ChatInterface";

const AUTHOR = { type: "agent", id: "cloudflare/auto", name: "Auto Router" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

function routed(model: string): AiModelRouting {
  return { model, reason: "cost_optimal_within_pool" };
}

const TOOL_CALL: AiToolCall = { toolCallId: "t", toolName: "executeCode", input: { code: "" } };

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
