// Pino do catálogo de `mutations:t20` (issue #152, passo 0e do épico #13).
// `web-tools-mutants.ts` é dado puro (nenhum efeito colateral no import, ao
// contrário de `web-tools.ts`, que roda o harness de verdade contra um
// sandbox de `git archive`); este teste confere, num `npm test` normal e
// rápido, o que só apareceria em `npm run mutations:t20` (bem mais lento):
// os 9 mutantes existem, cada um mira um teste que existe de fato em
// `tests/web-*.test.ts`, e cada `before` ocorre exatamente uma vez, ao pé da
// letra, no `src/web/**` de verdade — o mesmo padrão de
// `tests/orchestration-child-runner-mutation-catalog.test.ts` (#112).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { webToolsMutants } from "../scripts/mutations/web-tools-mutants.js";

const root = resolve(__dirname, "..");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("mutations:t20 catalog (src/web/**)", () => {
  it("declara exatamente 9 mutantes", () => {
    expect(webToolsMutants).toHaveLength(9);
  });

  it("cada id de mutante é único", () => {
    const ids = webToolsMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mira apenas src/web/connector.ts (×3), fetch.ts (×2), safety.ts (×1), search.ts (×1), tool.ts (×2)", () => {
    const files = webToolsMutants.flatMap((mutant) => mutant.edits.map((edit) => edit.file));
    const counts = files.reduce<Record<string, number>>((acc, file) => {
      acc[file] = (acc[file] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      "src/web/connector.ts": 3,
      "src/web/fetch.ts": 3,
      "src/web/safety.ts": 1,
      "src/web/search.ts": 1,
      "src/web/tool.ts": 2,
    });
  });

  it("nenhum import de scripts/parity/**, nem npm run build", () => {
    const catalogSource = sourceOf("scripts/mutations/web-tools-mutants.ts");
    const runnerSource = sourceOf("scripts/mutations/web-tools.ts");
    const combined = `${catalogSource}\n${runnerSource}`;
    expect(/from\s+["'][^"']*\/parity\//u.test(combined)).toBe(false);
    expect(/npm run build/u.test(combined)).toBe(false);
  });

  it('grep -rn "LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace" scripts/mutations/ dá vazio (Resultado esperado da issue #152)', () => {
    const catalogSource = sourceOf("scripts/mutations/web-tools-mutants.ts");
    const runnerSource = sourceOf("scripts/mutations/web-tools.ts");
    const combined = `${catalogSource}\n${runnerSource}`;
    expect(/LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace/u.test(combined)).toBe(false);
  });

  for (const mutant of webToolsMutants) {
    it(`${mutant.id}: cada "before" ocorre exatamente uma vez, verbatim, no arquivo mirado`, () => {
      for (const edit of mutant.edits) {
        expect(edit.before.length).toBeGreaterThan(0);
        expect(occurrences(sourceOf(edit.file), edit.before), `${mutant.id} @ ${edit.file}`).toBe(
          1,
        );
      }
    });

    it(`${mutant.id}: o foco existe em tests/web-*.test.ts e o título do teste está lá`, () => {
      expect(mutant.focus.file).toMatch(/^tests\/web-.*\.test\.ts$/);
      const testSource = sourceOf(mutant.focus.file);
      expect(
        testSource.includes(`"${mutant.focus.test}"`) ||
          testSource.includes(`'${mutant.focus.test}'`),
        `${mutant.id}: título "${mutant.focus.test}" ausente de ${mutant.focus.file}`,
      ).toBe(true);
    });
  }
});
