import { describe, expect, it } from "vitest";

import { mediaMutants } from "../scripts/mutations/media.js";

// Issue #151 (13-S4, épico #13): migra os 20 mutantes de mídia de
// `scripts/parity/media/run-mutations.ts` (17 `results.push` + laço de 3
// em `:299-345`, hoje posicionais) para um catálogo declarativo com `id` e
// `category` explícitos. Este teste-pino prende a contagem e a unicidade
// dos ids — o comportamento de cada mutante (killed/restoreGreen) é
// evidenciado por `npm run mutations:t21`, não por vitest (mecânica B roda
// um comparador dentro do processo, não um foco de vitest).
describe("catálogo mutations:t21 (scripts/mutations/media.ts)", () => {
  it("declara exatamente 20 mutantes", () => {
    expect(mediaMutants.length).toBe(20);
  });

  it("cada mutante tem um id único", () => {
    const ids = mediaMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cada mutante declara category, entry e ao menos um edit", () => {
    for (const mutant of mediaMutants) {
      expect(mutant.category.length).toBeGreaterThan(0);
      expect(mutant.entry.length).toBeGreaterThan(0);
      expect(mutant.edits.length).toBeGreaterThan(0);
    }
  });
});
