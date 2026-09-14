// Issue #586 (épico #575), item 2: prompt caching automático de prefixo do
// provedor Chat Completions depende só de uma coisa que o transporte já
// fazia — a ORDEM das tool definitions (e do resto do request) ser idêntica
// entre chamadas com o mesmo input. Nenhuma mudança de comportamento aqui;
// este teste caracteriza (e prende) o que já é verdade, para a issue não
// regredir isso silenciosamente no futuro.
import { describe, expect, it } from "vitest";

import { ChatCompletionsTransport } from "../src/transports/chat-completions.js";
import type { BuildKwargsOptions } from "../src/transports/types.js";

function request(): BuildKwargsOptions {
  return {
    model: "gpt-4o-mini",
    system: "SYSTEM",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "c", description: "", parameters: {} } },
      { type: "function", function: { name: "a", description: "", parameters: {} } },
      { type: "function", function: { name: "b", description: "", parameters: {} } },
    ],
  };
}

describe("ChatCompletionsTransport tool order determinism (#586)", () => {
  it("produces byte-identical kwargs across two calls with the same input", () => {
    const transport = new ChatCompletionsTransport();
    const first = transport.buildKwargs(request());
    const second = transport.buildKwargs(request());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("never reorders tools relative to the input array", () => {
    const transport = new ChatCompletionsTransport();
    const kwargs = transport.buildKwargs(request());
    const tools = kwargs.tools as readonly Record<string, unknown>[];
    const names = tools.map((tool) => (tool.function as { readonly name: string }).name);
    expect(names).toEqual(["c", "a", "b"]);
  });
});
