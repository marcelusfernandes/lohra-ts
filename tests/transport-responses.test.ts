// Issue #586 (épico #575), item 2: o transporte Responses fica sem mudança
// de forma -- `instructions` continua a mesma string junta de sempre, nunca
// um array de blocos (a API Responses não tem `cache_control` por bloco de
// texto do jeito que Messages tem). Este teste prende que a string continua
// igual mesmo recebendo um `system` já achatado (`systemPromptText`), que é
// o que um caller que decidiu passar as faixas mandaria adiante.
import { describe, expect, it } from "vitest";

import { systemPromptText } from "../src/context/system-prompt.js";
import { ResponsesTransport } from "../src/transports/responses.js";

describe("ResponsesTransport instructions unchanged (#586)", () => {
  it("keeps instructions as a plain joined string for a flat system", () => {
    const transport = new ResponsesTransport();
    const kwargs = transport.buildKwargs({
      model: "gpt-4o-mini",
      system: "SYSTEM",
      messages: [
        { role: "system", content: "EXTRA" },
        { role: "user", content: "hi" },
      ],
    });
    expect(kwargs.instructions).toBe("SYSTEM\n\nEXTRA");
    expect(typeof kwargs.instructions).toBe("string");
  });

  it("keeps instructions a plain string even when the caller flattens bands first", () => {
    const transport = new ResponsesTransport();
    const flattened = systemPromptText({ stable: "STABLE", context: "CONTEXT", volatile: "" });
    const kwargs = transport.buildKwargs({
      model: "gpt-4o-mini",
      system: flattened,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(kwargs.instructions).toBe("STABLE\n\nCONTEXT");
  });
});
