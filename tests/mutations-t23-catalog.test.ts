// Pino do catálogo de `mutations:t23` (issue #293, fatia `context-window`).
// `context-window.ts` é um único arquivo (catálogo + runner, atrás da mesma
// guarda de entry-point dos outros seis — `ehEntryPoint`,
// `scripts/mutations/harness.ts`) porque o `Files` da issue só autoriza
// `scripts/mutations/context-window.ts` como script novo, ao contrário de
// `web-tools.ts`/`web-tools-mutants.ts` (runner e catálogo separados).
// Importar só `contextWindowMutants` aqui nunca dispara `main()`
// (`tests/mutations-runner-guard.test.ts` prova a guarda para os seis
// runners; este módulo segue o mesmo padrão). Este teste confere, num
// `npm test` normal e rápido, o que só apareceria em `npm run mutations:t23`
// (bem mais lento): os 15 mutantes existem, cada um mira um teste que já
// existe de fato, e cada `before` ocorre exatamente uma vez, ao pé da letra,
// no arquivo de `src/` mirado — mesmo padrão de
// `tests/mutations-t20-catalog.test.ts` (#152).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { contextWindowMutants } from "../scripts/mutations/context-window.js";

const root = resolve(__dirname, "..");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("mutations:t23 catalog (compaction, estimator, context window)", () => {
  it("declara exatamente 15 mutantes", () => {
    expect(contextWindowMutants).toHaveLength(15);
  });

  it("cada id de mutante é único", () => {
    const ids = contextWindowMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mira apenas compaction.ts (×4), runtime.ts (×2), token-estimate.ts (×2), context-window.ts (×2), windows-cache.ts (×2), session-repository.ts (×3)", () => {
    // Conta MUTANTES por arquivo (não edits) -- cada mutante deste catálogo
    // tem um único edit, então as duas contagens coincidem aqui, mas o
    // padrão (Set por mutante) segue mutations-t20-catalog.test.ts, que
    // precisa dele para mutantes com múltiplos edits no mesmo arquivo.
    const counts: Record<string, number> = {};
    for (const mutant of contextWindowMutants) {
      for (const file of new Set(mutant.edits.map((edit) => edit.file))) {
        counts[file] = (counts[file] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({
      "src/conversation/compaction.ts": 4,
      "src/conversation/runtime.ts": 2,
      "src/context/token-estimate.ts": 2,
      "src/providers/context-window.ts": 2,
      "src/catalog/windows-cache.ts": 2,
      "src/state/session-repository.ts": 3,
    });
  });

  it("nenhum import do diretório histórico de paridade, nem npm run build", () => {
    const source = sourceOf("scripts/mutations/context-window.ts");
    expect(/from\s+["'][^"']*\/parity\//u.test(source)).toBe(false);
    expect(/npm run build/u.test(source)).toBe(false);
  });

  it('grep -rn "LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace" scripts/mutations/context-window.ts dá vazio', () => {
    const source = sourceOf("scripts/mutations/context-window.ts");
    expect(/LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace/u.test(source)).toBe(false);
  });

  for (const mutant of contextWindowMutants) {
    it(`${mutant.id}: cada "before" ocorre exatamente uma vez, verbatim, no arquivo mirado`, () => {
      for (const edit of mutant.edits) {
        expect(edit.before.length).toBeGreaterThan(0);
        expect(occurrences(sourceOf(edit.file), edit.before), `${mutant.id} @ ${edit.file}`).toBe(
          1,
        );
      }
    });

    it(`${mutant.id}: o foco existe em tests/ e o título do teste está lá, exatamente uma vez`, () => {
      expect(mutant.focus.file).toMatch(/^tests\/.*\.test\.ts$/);
      const testSource = sourceOf(mutant.focus.file);
      expect(
        occurrences(testSource, mutant.focus.test),
        `${mutant.id}: "${mutant.focus.test}" não ocorre exatamente uma vez em ${mutant.focus.file}`,
      ).toBe(1);
    });
  }
});
