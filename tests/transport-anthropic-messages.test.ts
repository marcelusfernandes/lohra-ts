// Issue #586 (épico #575): prompt caching real na rota Anthropic — `system`
// vira blocos de texto com `cache_control: {type: "ephemeral"}` na fronteira
// `stable+context` (a faixa `volatile` e qualquer mensagem `role: "system"`
// ficam DEPOIS do breakpoint, nunca cacheadas) e na última definição de
// tool. Nada muda no TEXTO que o modelo lê (invariante 1, CLAUDE.md) — só a
// forma; o teste de byte-identidade abaixo prende isso.
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/context/system-prompt.js";
import { AnthropicMessagesTransport } from "../src/transports/anthropic-messages.js";

function textOf(block: unknown): string {
  const record = block as { readonly text?: unknown };
  return typeof record.text === "string" ? record.text : "";
}

function cacheControlOf(block: unknown): unknown {
  return (block as { readonly cache_control?: unknown }).cache_control;
}

describe("AnthropicMessagesTransport prompt caching (#586)", () => {
  it("sends system as an array of text blocks, not a joined string", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      system: { stable: "STABLE", context: "CONTEXT", volatile: "VOLATILE" },
    });
    expect(Array.isArray(kwargs.system)).toBe(true);
  });

  it("marks cache_control only on the last block of stable+context, never on volatile", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      system: { stable: "STABLE", context: "CONTEXT", volatile: "VOLATILE" },
    });
    const blocks = kwargs.system as readonly unknown[];
    expect(blocks).toHaveLength(3);
    expect(cacheControlOf(blocks[0])).toBeUndefined();
    expect(cacheControlOf(blocks[1])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(blocks[2])).toBeUndefined();
  });

  it("treats a plain string system (every caller before this issue) as the whole stable band", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      system: "FLAT TEXT",
    });
    const blocks = kwargs.system as readonly unknown[];
    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0])).toBe("FLAT TEXT");
    expect(cacheControlOf(blocks[0])).toEqual({ type: "ephemeral" });
  });

  it("omits an empty band and still caches only the last of stable/context present", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      system: { stable: "STABLE", context: "", volatile: "" },
    });
    const blocks = kwargs.system as readonly unknown[];
    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0])).toBe("STABLE");
    expect(cacheControlOf(blocks[0])).toEqual({ type: "ephemeral" });
  });

  it("puts cache_control on the last tool definition only", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "", parameters: {} } },
        { type: "function", function: { name: "b", description: "", parameters: {} } },
      ],
    });
    const tools = kwargs.tools as readonly Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
    // The tool definitions themselves are untouched otherwise.
    expect(tools[0]?.name).toBe("a");
    expect(tools[1]?.name).toBe("b");
  });

  it("never adds cache_control when there are no tools", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(kwargs.tools).toBeUndefined();
  });

  it("keeps trailing role:system messages after the breakpoint, uncached", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "EXTRA" },
        { role: "user", content: "hi" },
      ],
      system: { stable: "STABLE", context: "", volatile: "" },
    });
    const blocks = kwargs.system as readonly unknown[];
    expect(blocks).toHaveLength(2);
    expect(cacheControlOf(blocks[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(blocks[1])).toBeUndefined();
  });

  it("is byte-identical to today's flattened .text once blocks are concatenated (invariant 1)", () => {
    const snapshot = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE",
      systemMessage: "caller",
      memorySnapshot: "remember",
      today: "2030-01-02",
    });
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      system: snapshot,
    });
    const blocks = kwargs.system as readonly unknown[];
    const concatenated = blocks.map(textOf).join("");
    expect(concatenated).toBe(snapshot.text);
  });

  it("is byte-identical for a flat string system too, matching the pre-#586 joined form", () => {
    const transport = new AnthropicMessagesTransport();
    const kwargs = transport.buildKwargs({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "trailing one" },
        { role: "system", content: "trailing two" },
        { role: "user", content: "hi" },
      ],
      system: "FLAT",
    });
    const blocks = kwargs.system as readonly unknown[];
    const concatenated = blocks.map(textOf).join("");
    expect(concatenated).toBe(["FLAT", "trailing one", "trailing two"].join("\n\n"));
  });
});
