import { describe, expect, it } from "vitest";

import { resolveContextWindowOverride } from "../src/config/context-window-env.js";

describe("resolveContextWindowOverride — LOHRA_CONTEXT_WINDOW (issue #250)", () => {
  it("ausente ou vazio devolve null, nunca um default inventado", () => {
    expect(resolveContextWindowOverride({})).toBeNull();
    expect(resolveContextWindowOverride({ LOHRA_CONTEXT_WINDOW: "" })).toBeNull();
    expect(resolveContextWindowOverride({ LOHRA_CONTEXT_WINDOW: "   " })).toBeNull();
  });

  it("um inteiro positivo válido devolve o número", () => {
    expect(resolveContextWindowOverride({ LOHRA_CONTEXT_WINDOW: "128000" })).toBe(128_000);
    expect(resolveContextWindowOverride({ LOHRA_CONTEXT_WINDOW: " 1 " })).toBe(1);
  });

  it("valor inválido lança erro nomeado — nunca é ignorado silenciosamente", () => {
    for (const bad of ["abc", "0", "-5", "12.5", "1e5", "1_0"]) {
      expect(() => resolveContextWindowOverride({ LOHRA_CONTEXT_WINDOW: bad })).toThrow(
        /LOHRA_CONTEXT_WINDOW_INVALID/,
      );
    }
  });
});
