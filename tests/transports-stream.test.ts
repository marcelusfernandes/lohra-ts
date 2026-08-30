import { describe, expect, it, vi } from "vitest";

import { assembleStreamedResponse, ChatCompletionsTransport } from "../src/transports/index.js";

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): unknown => ({
  choices: [{ delta, finish_reason: finishReason }],
});

describe("assembleStreamedResponse", () => {
  it("preserves callback order while reasoning remains callback-only", () => {
    const calls: string[] = [];
    const raw = assembleStreamedResponse(
      [
        chunk({ content: "a" }),
        chunk({ reasoning_content: "r1" }),
        chunk({ content: "" }),
        chunk({ content: "b", reasoning_content: "r2" }, "stop"),
      ],
      {
        onText: (value) => calls.push(`text:${value}`),
        onReasoning: (value) => calls.push(`reasoning:${value}`),
      },
    );

    expect(calls).toEqual(["text:a", "reasoning:r1", "text:b", "reasoning:r2"]);
    expect(new ChatCompletionsTransport().normalizeResponse(raw)).toMatchObject({
      content: "ab",
      reasoning: null,
    });
  });

  it("takes the last usage even from an empty-choices chunk", () => {
    const raw = assembleStreamedResponse([
      { choices: [], usage: { prompt_tokens: 1 } },
      chunk({ content: "x" }, "stop"),
      { choices: [], usage: { prompt_tokens: 9 } },
    ]);
    expect(raw).toMatchObject({ usage: { prompt_tokens: 9 } });
  });

  it("assembles interleaved slots in first-seen order", () => {
    const raw = assembleStreamedResponse([
      chunk({
        tool_calls: [{ index: 2, function: { arguments: '{"a":' } }],
      }),
      chunk({
        tool_calls: [{ index: 1, id: "c1", function: { name: "second", arguments: "{}" } }],
      }),
      chunk(
        {
          tool_calls: [{ index: 2, id: "c2", function: { name: "first", arguments: "1}" } }],
        },
        "tool_calls",
      ),
    ]);
    expect(raw).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c2", function: { name: "first", arguments: '{"a":1}' } },
              { id: "c1", function: { name: "second", arguments: "{}" } },
            ],
          },
        },
      ],
    });
  });

  it("uses id, recent slot, then zero as slot fallbacks", () => {
    const raw = assembleStreamedResponse([
      chunk({ tool_calls: [{ id: "c1", function: { name: "pick", arguments: "{" } }] }),
      chunk({ tool_calls: [{ function: { arguments: "}" } }] }, "tool_calls"),
    ]);
    expect(raw).toMatchObject({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { arguments: "{}" } }] } }],
    });
  });

  it.each([
    [[chunk({}, "tool_calls")]],
    [[chunk({ tool_calls: [{ index: 0, function: { name: "x" } }] }, "tool_calls")]],
    [[chunk({ tool_calls: [{ index: 0, id: "c" }] }, "tool_calls")]],
    [[chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "" } }] }, "tool_calls")]],
  ])("rejects incomplete tool-call streams", (chunks) => {
    expect(() => assembleStreamedResponse(chunks)).toThrow("incomplete tool-call stream");
  });

  it("drops orphan slots and emits the literal warning", () => {
    const warning = vi.fn();
    const raw = assembleStreamedResponse(
      [chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "x" } }] }, "stop")],
      { onWarning: warning },
    );
    expect(warning).toHaveBeenCalledWith(
      "discarding 1 orphaned tool-call stream slot(s); finish_reason='stop'",
    );
    expect(raw).not.toHaveProperty("choices.0.message.tool_calls");
  });

  it("fuzzes interleaved slot indices while preserving first-seen order", () => {
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const indices = Array.from({ length: 2 + (next() % 12) }, (_value, index) => index);
      indices.sort(() => (next() & 1) - 0.5);
      const chunks = indices.flatMap((index) => [
        chunk({ tool_calls: [{ index, function: { arguments: `{"i":${String(index)}` } }] }),
        chunk({
          tool_calls: [
            {
              index,
              id: `c${String(index)}`,
              function: { name: `f${String(index)}`, arguments: "}" },
            },
          ],
        }),
      ]);
      chunks.push(chunk({}, "tool_calls"));
      const raw = assembleStreamedResponse(chunks);
      const calls = (raw.choices as Array<Record<string, unknown>>)[0]?.message as {
        tool_calls: Array<{ id: string; function: { arguments: string } }>;
      };
      expect(calls.tool_calls.map((call) => call.id)).toEqual(
        indices.map((index) => `c${String(index)}`),
      );
      expect(
        calls.tool_calls.map((call) => JSON.parse(call.function.arguments) as unknown),
      ).toEqual(indices.map((index) => ({ i: index })));
    }
  });
});
