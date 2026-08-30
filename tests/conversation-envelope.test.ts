import { describe, expect, it } from "vitest";

import { errorEnvelope, successEnvelope } from "../src/conversation/index.js";

function parseObject(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("ENVELOPE_NOT_OBJECT");
  return parsed as Record<string, unknown>;
}

const zeroCost = {
  usd: 0,
  grossUsd: 0,
  savedUsd: 0,
  basis: "local" as const,
};
const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};
const summary = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  apiCallCount: 1,
  pricedCallCount: 1,
  actualCostUsd: 0,
  estimatedCostUsd: 0,
};

describe("conversation envelopes", () => {
  it("keeps insertion order, Python floats, omitted usage zeros and ensure_ascii", () => {
    const body = successEnvelope({
      sessionId: "s",
      model: "m",
      temperature: null,
      input: `olá 😀 ${String.fromCharCode(0x7f)}`,
      response: {
        content: "ok",
        finishReason: "stop",
        toolCalls: [],
        reasoning: null,
        usage,
        providerData: null,
      },
      usageTotal: usage,
      cost: zeroCost,
      apiCalls: 1,
      sessionSummary: summary,
    });
    expect(body).toContain('"input": "ol\\u00e1 \\ud83d\\ude00 \\u007f"');
    expect(Buffer.from(body).some((byte) => byte > 0x7e)).toBe(false);
    expect(body.match(/0\.0/g)).toHaveLength(5);
    expect(body.indexOf('"session_id"')).toBeLessThan(body.indexOf('"model"'));
    expect(body.indexOf('"api_calls"')).toBeLessThan(body.indexOf('"session"'));
    const parsed = parseObject(body);
    expect(parsed.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(parsed.session).toMatchObject({
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it("omits session for pre-response errors and includes it for incomplete responses", () => {
    const early = parseObject(
      errorEnvelope({ sessionId: "s", model: "m", prompt: "x", error: "failure", apiCalls: 1 }),
    );
    expect(Object.keys(early)).toHaveLength(14);
    expect(early).not.toHaveProperty("session");

    const incomplete = parseObject(
      errorEnvelope({
        sessionId: "s",
        model: "m",
        prompt: "x",
        error: "provider returned incomplete tool_calls",
        apiCalls: 1,
        usage,
        cost: zeroCost,
        sessionSummary: summary,
      }),
    );
    expect(Object.keys(incomplete)).toHaveLength(15);
    expect(incomplete).toMatchObject({
      stop_reason: null,
      completed: false,
      usage: { input_tokens: 11, output_tokens: 7 },
      session: { api_call_count: 1, priced_call_count: 1 },
    });
  });
});
