import { describe, expect, it } from "vitest";

import { ChatCompletionsTransport } from "../src/transports/index.js";

describe("ChatCompletionsTransport.buildKwargs", () => {
  it("preserves insertion order, two system messages, and unknown-role fallback", () => {
    const transport = new ChatCompletionsTransport();
    const result = transport.buildKwargs({
      model: "m",
      system: "TOP",
      messages: [
        { role: "system", content: "INLINE" },
        { role: "weird", content: "hello" },
        { role: "tool", tool_call_id: "c1", content: null },
      ],
      maxTokens: 0,
      temperature: 0,
      effort: "",
      tools: [],
      toolChoice: "",
    });

    expect(Object.keys(result)).toEqual([
      "model",
      "messages",
      "max_tokens",
      "temperature",
      "reasoning_effort",
      "tool_choice",
    ]);
    expect(result).toEqual({
      model: "m",
      messages: [
        { role: "system", content: "TOP" },
        { role: "system", content: "INLINE" },
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "c1", content: "" },
      ],
      max_tokens: 0,
      temperature: 0,
      reasoning_effort: "",
      tool_choice: { type: "function", function: { name: "" } },
    });
  });

  it("copies content parts and tools while preserving raw string arguments", () => {
    const content = [{ type: "text", text: "hello" }];
    const tools = [
      {
        type: "function",
        function: { name: "pick", parameters: { type: "object" } },
      },
    ];
    const messages = [
      { role: "user", content },
      {
        role: "assistant",
        content: null,
        reasoning: "drop",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "pick", arguments: `a${String.fromCharCode(0x7f)}b` },
          },
          { id: "c2", type: "function", function: { name: "obj", arguments: { k: "ab" } } },
        ],
      },
    ];

    const result = new ChatCompletionsTransport().buildKwargs({ model: "m", messages, tools });
    const outputMessages = result.messages as Array<Record<string, unknown>>;
    const outputTools = result.tools as unknown[];
    const calls = outputMessages[1]?.tool_calls as Array<{
      function: { arguments: string };
    }>;

    expect(outputMessages[0]?.content).toEqual(content);
    expect(outputMessages[0]?.content).not.toBe(content);
    expect(outputTools).toEqual(tools);
    expect(outputTools).not.toBe(tools);
    expect(calls[0]?.function.arguments).toBe(`a${String.fromCharCode(0x7f)}b`);
    expect(calls[1]?.function.arguments).toBe('{"k": "a\\u007fb"}');
    expect(messages).toEqual([
      { role: "user", content },
      {
        role: "assistant",
        content: null,
        reasoning: "drop",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "pick", arguments: `a${String.fromCharCode(0x7f)}b` },
          },
          { id: "c2", type: "function", function: { name: "obj", arguments: { k: "ab" } } },
        ],
      },
    ]);
  });
});

describe("ChatCompletionsTransport.normalizeResponse", () => {
  it("normalizes empty choices and finish reasons", () => {
    const transport = new ChatCompletionsTransport();
    expect(transport.normalizeResponse({ choices: [] })).toEqual({
      content: null,
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage: null,
      providerData: null,
    });
    for (const [raw, expected] of [
      ["stop", "stop"],
      ["length", "length"],
      ["tool_calls", "tool_calls"],
      ["function_call", "tool_calls"],
      ["content_filter", "content_filter"],
      [null, "stop"],
      ["weird", "stop"],
    ] as const) {
      expect(
        transport.normalizeResponse({
          choices: [{ message: { content: "x" }, finish_reason: raw }],
        }).finishReason,
      ).toBe(expected);
    }
  });

  it("normalizes tools, reasoning, and disjoint prompt usage", () => {
    const result = new ChatCompletionsTransport().normalizeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "thought",
            tool_calls: [
              { id: null, function: { name: null, arguments: null } },
              { id: "c2", function: { name: "pick", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    });

    expect(result).toEqual({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [
        { id: null, name: "", arguments: "{}", providerData: null },
        { id: "c2", name: "pick", arguments: "{}", providerData: null },
      ],
      reasoning: "thought",
      usage: {
        inputTokens: 60,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        reasoningTokens: 7,
      },
      providerData: null,
    });
  });

  it("uses Kimi fallback only for falsy details and preserves the negative clamp", () => {
    const transport = new ChatCompletionsTransport();
    const normalize = (prompt: number, detail: number, top: number) =>
      transport.normalizeResponse({
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: 0,
          cached_tokens: top,
          prompt_tokens_details: { cached_tokens: detail },
        },
      }).usage;

    expect(normalize(100, 0, 40)?.cacheReadTokens).toBe(40);
    expect(normalize(100, 10, 40)?.cacheReadTokens).toBe(10);
    expect(normalize(10, 999, 0)).toMatchObject({ inputTokens: 0, cacheReadTokens: 10 });
    expect(normalize(-5, 999, 0)).toMatchObject({ inputTokens: 0, cacheReadTokens: -5 });
  });

  it("fuzzes prompt/cache partitioning without making the five meters disjoint", () => {
    const transport = new ChatCompletionsTransport();
    for (let prompt = -32; prompt <= 128; prompt += 1) {
      for (const cached of [-50, -1, 0, 1, 17, 256]) {
        const result = transport.normalizeResponse({
          choices: [{ message: { content: null }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: cached },
            completion_tokens_details: { reasoning_tokens: 7 },
          },
        }).usage;
        const clamped = Math.min(cached, prompt);
        expect(result).toMatchObject({
          inputTokens: prompt - clamped,
          outputTokens: 20,
          cacheReadTokens: clamped,
          cacheWriteTokens: 0,
          reasoningTokens: 7,
        });
        expect((result?.inputTokens ?? 0) + (result?.cacheReadTokens ?? 0)).toBe(prompt);
      }
    }
  });
});
