// Stopping an agent mid-request over the AI Gateway binding transport. The binding's passthrough
// fetch is not known to honor RequestInit.signal, so these fakes ignore it the way it may: a model
// that is thinking silently (no stream events for minutes) must still stop when the user asks.

import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel } from "../src/ai-models.js";

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-123", name: "User" };

const ANTHROPIC_CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiToken: "ignored-in-gateway-mode",
};

function bindingEnv(binding: Ai): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,cloudflare",
    WORKERS_AI: binding,
  } as Cloudflare.Env;
}

// How long a stopped request may take to end. Far below the minutes a silent model can take.
const PROMPT_MS = 2_000;

async function runUntilStopped(binding: Ai, abortAfterMs: number) {
  const handle = getModel(bindingEnv(binding), ANTHROPIC_CONFIG, INITIATOR);
  const controller = new AbortController();
  const stream = handle.stream(handle.model, {
    messages: [{ role: "user", content: "think hard", timestamp: 0 }],
  }, { maxRetries: 0, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("User requested to stop agent.")), abortAfterMs);
  return Promise.race([
    stream.result(),
    new Promise<"still running">(resolve => setTimeout(() => resolve("still running"), PROMPT_MS)),
  ]);
}

describe("stopping a request on the AI Gateway binding", () => {
  it("ends a silent streaming response and cancels it upstream", async () => {
    let upstreamCancelled = false;
    const silentModel = {
      // Headers arrive, then nothing: a model reasoning before its first event.
      fetch: async () => new Response(new ReadableStream({
        cancel() { upstreamCancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } }),
    } as unknown as Ai;

    const message = await runUntilStopped(silentModel, 50);
    expect(message).not.toBe("still running");
    expect(message).toMatchObject({ stopReason: "aborted" });
    expect(upstreamCancelled).toBe(true);
  });

  it("passes a normal streamed reply through untouched", async () => {
    // A complete Anthropic Messages stream, sent in small chunks the way the gateway relays it.
    const events = [
      ["message_start", { type: "message_start", message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const bytes = new TextEncoder().encode(sse);
    const model = {
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    } as unknown as Ai;

    const handle = getModel(bindingEnv(model), ANTHROPIC_CONFIG, INITIATOR);
    const controller = new AbortController();
    const message = await handle.stream(handle.model, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }, { maxRetries: 0, signal: controller.signal }).result();
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello, world" }]);
  });

  it("ends a request whose response has not even started", async () => {
    const unresponsive = { fetch: () => new Promise<Response>(() => {}) } as unknown as Ai;
    const message = await runUntilStopped(unresponsive, 50);
    expect(message).not.toBe("still running");
    expect(message).toMatchObject({ stopReason: "aborted" });
  });
});
