import { describe, expect, it } from "vitest";

import { estimateUsage, wireUsage } from "../src/server/usage.js";

describe("wireUsage — provider-reported usage projected to the OpenAI wire shape", () => {
  it("reconstructs prompt_tokens as input + cache_read + cache_write (assertion 61)", () => {
    const usage = wireUsage({
      inputTokens: 60,
      outputTokens: 5,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(40);
    expect(usage.total_tokens).toBe(105);
  });

  it("matches the measured baseline vector: input 100 cached 40 reasoning 3", () => {
    // evidence-s09-gaps.json#chat_no_limits / #resp_max_output_tokens
    const usage = wireUsage({
      inputTokens: 60,
      outputTokens: 7,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    });
    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
  });
});

describe("estimateUsage — no provider usage, Python-faithful str()-based estimate", () => {
  it("matches the mandatory B5 vector: parts content 66 chars -> prompt 16", () => {
    // evidence-s09-gaps.json#estimate_parts_content:
    // "SCEN:nousage seed" (17) + "ok" (2) + repr([{'type':'text','text':'SCEN:nousage abcd'}]) (47) = 66
    const messages = [
      { role: "user", content: "SCEN:nousage seed" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "SCEN:nousage abcd" }] },
    ];
    const usage = estimateUsage(messages, "abcdefgh");
    expect(usage.prompt_tokens).toBe(16);
    expect(usage.completion_tokens).toBe(2);
    expect(usage.total_tokens).toBe(18);
  });

  it("a JSON.stringify-compact estimate (63 chars -> 15) must NOT be what this produces", () => {
    const messages = [
      { role: "user", content: "SCEN:nousage seed" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "SCEN:nousage abcd" }] },
    ];
    const usage = estimateUsage(messages, "abcdefgh");
    expect(usage.prompt_tokens).not.toBe(15);
    const jsonStringifyLength = JSON.stringify([{ type: "text", text: "SCEN:nousage abcd" }]).length;
    expect(jsonStringifyLength).not.toBe(47); // sanity: JSON.stringify diverges from the Python repr
  });

  it("chat content string 31 chars -> prompt 7", () => {
    const messages = [{ role: "user", content: "x".repeat(31) }];
    expect(estimateUsage(messages, "").prompt_tokens).toBe(7);
  });

  it("completion 8 chars -> 2 tokens, empty completion floors to 1", () => {
    expect(estimateUsage([], "12345678").completion_tokens).toBe(2);
    expect(estimateUsage([], "").completion_tokens).toBe(1);
  });

  it("Responses parts already concatenated to a plain string: 17 chars -> input_tokens 4", () => {
    // evidence-s09-gaps.json#estimate_responses_parts (parse_responses_input already
    // flattened the part list to a string before this estimator ever sees it)
    const messages = [{ role: "user", content: "SCEN:nousage abcd" }];
    expect(estimateUsage(messages, "abcdefgh").prompt_tokens).toBe(4);
  });

  it("ignores non-string, non-object falsy content the same way Python's `or \"\"` does", () => {
    const messages = [{ role: "user", content: null }, { role: "user", content: "" }];
    expect(estimateUsage(messages, "x").prompt_tokens).toBe(0);
  });

  it("estimated usage always reports zeroed cache/reasoning details", () => {
    const usage = estimateUsage([{ role: "user", content: "hi" }], "yo");
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
    expect(usage.completion_tokens_details).toEqual({ reasoning_tokens: 0 });
  });
});
