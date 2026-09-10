import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { estimateTokens } from "../src/context/token-estimate.js";

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures/context");

interface CapturedFixture {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly usage: { readonly inputTokens: number };
}

function loadFixtures(): readonly [string, CapturedFixture][] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name,
      JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as CapturedFixture,
    ]);
}

const fixtures = loadFixtures();

describe("estimateTokens — fixtures reais (issue #251)", () => {
  it("has at least two fixtures from distinct providers", () => {
    const providers = new Set(fixtures.map(([, fixture]) => fixture.provider));
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });

  it.each(fixtures)("%s: estimate is never below the real usage.inputTokens", (_name, fixture) => {
    const estimate = estimateTokens(fixture.messages);
    expect(estimate.method).toBe("heuristic");
    expect(estimate.tokens).toBeGreaterThanOrEqual(fixture.usage.inputTokens);
  });

  it.each(fixtures)(
    "%s: estimate stays within 2x the real usage.inputTokens (relative error)",
    (_name, fixture) => {
      const estimate = estimateTokens(fixture.messages);
      const ratio = estimate.tokens / fixture.usage.inputTokens;
      expect(ratio).toBeLessThanOrEqual(2);
    },
  );

  it("does not mutate the messages array it receives", () => {
    for (const [, fixture] of fixtures) {
      const before = structuredClone(fixture.messages);
      estimateTokens(fixture.messages);
      expect(fixture.messages).toEqual(before);
    }
  });
});

describe("estimateTokens — unidade", () => {
  it("returns zero tokens for an empty history", () => {
    expect(estimateTokens([])).toEqual({ tokens: 0, method: "heuristic" });
  });

  it("charges plain text content", () => {
    const short = estimateTokens([{ role: "user", content: "oi" }]);
    const long = estimateTokens([{ role: "user", content: "oi ".repeat(200) }]);
    expect(long.tokens).toBeGreaterThan(short.tokens);
  });

  // Valores exatos (não só "> 0"/"maior que"): pinam MESSAGE_OVERHEAD_TOKENS,
  // TEXT_CHARS_PER_TOKEN, JSON_CHARS_PER_TOKEN e TOOL_CALL_OVERHEAD_TOKENS —
  // um mutante que zere o overhead ou afrouxe um fator sobrevive aos testes
  // de "> 0" acima, mas não a estes (issue #251, evidência de que o teste
  // prende comportamento, não só existência de contagem).
  it("pins the exact token count for a short user message (message overhead + text factor)", () => {
    // MESSAGE_OVERHEAD_TOKENS (6) + ceil("oi".length / TEXT_CHARS_PER_TOKEN=2.9) = 6 + 1
    expect(estimateTokens([{ role: "user", content: "oi" }])).toEqual({
      tokens: 7,
      method: "heuristic",
    });
  });

  it("pins the exact token count for a tool result (message overhead + JSON factor)", () => {
    // 6 + ceil('{"a":1}'.length=7 / JSON_CHARS_PER_TOKEN=2.4) = 6 + 3
    expect(estimateTokens([{ role: "tool", tool_call_id: "c1", content: '{"a":1}' }])).toEqual({
      tokens: 9,
      method: "heuristic",
    });
  });

  it("pins the exact token count for a tool call (JSON factor + tool call overhead)", () => {
    // 6 (message) + ceil(("f".length=1 + "{}".length=2) / 2.4 = 2) + TOOL_CALL_OVERHEAD_TOKENS (4)
    expect(
      estimateTokens([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ]),
    ).toEqual({ tokens: 12, method: "heuristic" });
  });

  it("pins the exact token count for a reasoning-only message (JSON factor)", () => {
    // 6 + ceil("ab".length=2 / JSON_CHARS_PER_TOKEN=2.4) = 6 + 1
    expect(estimateTokens([{ role: "assistant", content: null, reasoning: "ab" }])).toEqual({
      tokens: 7,
      method: "heuristic",
    });
  });

  it("charges tool_calls arguments separately from message content", () => {
    const withoutCall = estimateTokens([{ role: "assistant", content: "ok" }]);
    const withCall = estimateTokens([
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"clima em São Paulo hoje"}' },
          },
        ],
      },
    ]);
    expect(withCall.tokens).toBeGreaterThan(withoutCall.tokens);
  });

  it("charges tool result content (role: tool)", () => {
    const estimate = estimateTokens([
      { role: "tool", tool_call_id: "c1", content: '{"status":"ok","value":42}' },
    ]);
    expect(estimate.tokens).toBeGreaterThan(0);
  });

  it("charges reasoning text on the message and on provider_data.thinking_blocks", () => {
    const plain = estimateTokens([{ role: "assistant", content: "resposta" }]);
    const withReasoning = estimateTokens([
      {
        role: "assistant",
        content: "resposta",
        reasoning: "pensando passo a passo sobre o pedido",
      },
    ]);
    const withThinkingBlocks = estimateTokens([
      {
        role: "assistant",
        content: "resposta",
        provider_data: {
          thinking_blocks: [
            { type: "thinking", thinking: "considerando as opções disponíveis", signature: "s" },
          ],
        },
      },
    ]);
    expect(withReasoning.tokens).toBeGreaterThan(plain.tokens);
    expect(withThinkingBlocks.tokens).toBeGreaterThan(plain.tokens);
  });

  it("charges structured content blocks (array content), including unknown block types conservatively", () => {
    const withText = estimateTokens([
      { role: "assistant", content: [{ type: "text", text: "olá, tudo bem?" }] },
    ]);
    expect(withText.tokens).toBeGreaterThan(0);

    const withUnknown = estimateTokens([
      {
        role: "assistant",
        content: [{ type: "some_future_block", payload: { a: 1, b: "x".repeat(50) } }],
      },
    ]);
    expect(withUnknown.tokens).toBeGreaterThan(0);
  });

  it("throws (never returns a silent zero) when messages is not an array", () => {
    expect(() =>
      estimateTokens(null as unknown as readonly Readonly<Record<string, unknown>>[]),
    ).toThrow();
    expect(() =>
      estimateTokens({ role: "user" } as unknown as readonly Readonly<Record<string, unknown>>[]),
    ).toThrow();
  });

  it("never makes a network call (module has no fetch/http import)", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/context/token-estimate.ts"),
      "utf8",
    );
    expect(/\bfetch\s*\(|node:https?|require\(["']https?["']\)/u.test(source)).toBe(false);
  });
});
