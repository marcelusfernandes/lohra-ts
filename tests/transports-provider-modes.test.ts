import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesTransport,
  ResponsesTransport,
  listTransports,
} from "../src/transports/index.js";

describe("AnthropicMessagesTransport", () => {
  it("lifts system messages, groups tool results and copies schemas", () => {
    const parameters = { type: "object", properties: { path: { type: "string" } } };
    const result = new AnthropicMessagesTransport().buildKwargs({
      model: "claude",
      system: "TOP",
      messages: [
        { role: "system", content: "HIST" },
        {
          role: "assistant",
          content: "x",
          provider_data: { thinking_blocks: [{ signature: "s", thinking: "r", type: "thinking" }] },
        },
        { role: "tool", tool_call_id: "c1", content: "one" },
        { role: "tool", tool_call_id: "c2", content: "two" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "d", parameters } }],
      maxTokens: 0,
      toolChoice: "read",
    });
    parameters.properties.path.type = "number";

    expect(result).toMatchObject({
      model: "claude",
      max_tokens: 4096,
      system: "TOP\n\nHIST",
      tool_choice: { type: "tool", name: "read" },
      tools: [
        {
          name: "read",
          description: "d",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [
          { signature: "s", thinking: "r", type: "thinking" },
          { type: "text", text: "x" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "one" },
          { type: "tool_result", tool_use_id: "c2", content: "two" },
        ],
      },
    ]);
  });

  it("normalizes thinking, tools, stop and disjoint usage", () => {
    expect(
      new AnthropicMessagesTransport().normalizeResponse({
        content: [
          { type: "thinking", signature: "sig", thinking: "why" },
          { type: "redacted_thinking", data: "blob" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "c1", name: "read", input: { path: "café", n: 1.0 } },
        ],
        stop_reason: "pause_turn",
        usage: { input_tokens: 70, output_tokens: 30, cache_read_input_tokens: 5 },
      }),
    ).toEqual({
      content: "answer",
      finishReason: "pause",
      toolCalls: [
        { id: "c1", name: "read", arguments: '{"path": "caf\\u00e9", "n": 1}', providerData: null },
      ],
      reasoning: "why",
      usage: {
        inputTokens: 70,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      providerData: {
        thinking_blocks: [
          { signature: "sig", thinking: "why", type: "thinking" },
          { data: "blob", type: "redacted_thinking" },
        ],
      },
    });
  });
});

describe("ResponsesTransport", () => {
  it("builds ordered replay and drops max-token caps", () => {
    const result = new ResponsesTransport().buildKwargs({
      model: "gpt-5.5",
      system: "TOP",
      maxTokens: 32,
      effort: "high",
      messages: [
        { role: "system", content: "HIST" },
        {
          role: "assistant",
          content: "a",
          provider_data: {
            reasoning_items: [
              { type: "reasoning", encrypted_content: "enc" },
              { type: "reasoning", encrypted_content: null },
            ],
          },
          tool_calls: [{ id: "c1", function: { name: "read", arguments: "raw" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "out" },
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ],
      toolChoice: "read",
    });
    expect(result).toMatchObject({
      model: "gpt-5.5",
      instructions: "TOP\n\nHIST",
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      tool_choice: { type: "function", name: "read" },
    });
    expect(result).not.toHaveProperty("max_tokens");
    expect(result.input).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "enc" },
      { role: "assistant", content: "a" },
      { type: "function_call", call_id: "c1", name: "read", arguments: "raw" },
      { type: "function_call_output", call_id: "c1", output: "out" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    ]);
  });

  it("normalizes status, replay blobs, refusal and inclusive cached usage", () => {
    expect(
      new ResponsesTransport().normalizeResponse({
        status: "incomplete",
        output: [
          {
            type: "reasoning",
            encrypted_content: "enc",
            summary: [{ type: "summary_text", text: "why" }],
          },
          { type: "reasoning", encrypted_content: null, summary: [{ text: "more" }] },
          {
            type: "message",
            content: [
              { type: "output_text", text: "x" },
              { type: "refusal", refusal: "no" },
            ],
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ).toEqual({
      content: "xno",
      finishReason: "length",
      toolCalls: [],
      reasoning: "whymore",
      usage: {
        inputTokens: 15,
        outputTokens: 7,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
      },
      providerData: {
        reasoning_items: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "why" }],
            encrypted_content: "enc",
          },
        ],
      },
    });
  });
});

it("registers exactly the three transport modes", () => {
  expect(listTransports()).toEqual(["anthropic_messages", "chat_completions", "responses"]);
});
