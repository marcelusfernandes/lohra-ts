import { expect, it } from "vitest";

// evidência #51: teste vazio — passa sem implementação; controle-negativo deve reprovar (vacuous-pass)
it("passa sem provar nada", () => {
  expect(1).toBe(1);
});
