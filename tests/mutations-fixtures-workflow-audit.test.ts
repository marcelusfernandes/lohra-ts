// Issue #370: teste de FORMA do catálogo novo
// `scripts/mutations/workflow-audit-producers-mutants.ts` — no molde de
// `tests/mutations-fixtures-workflow-executor.test.ts`, mas mais amplo:
// aqui não há uma fixture única para pinar, e sim 16 mutantes espalhados por
// quatro módulos novos do M7 (`audit-producers.ts`, `audit-runtime.ts`,
// `audit-cache.ts`, `live-tail.ts`). Duas propriedades, cada uma independente
// de rodar o harness de mutação de verdade (`npm run mutations:t17`, minutos
// de `git archive` + vitest em subprocesso):
//
//   1. toda âncora (`edits[].before`) ocorre EXATAMENTE UMA VEZ, verbatim, no
//      arquivo alvo — reusa `replaceExactlyOnce` do harness comum
//      (`scripts/mutations/harness.ts`) em vez de reimplementar a contagem;
//      a mesma função que o runner chama de verdade, então uma âncora que
//      passa aqui não pode falhar por "not found"/"not unique" lá.
//   2. `focus.test` (título literal do `it`, substring do `fullName` que o
//      vitest casa por `-t`, veredito da PR #371/#362) existe VERBATIM em
//      algum lugar do `focus.file` — não precisa ser um match de AST
//      (`it("...")` vs `it('...')` etc.), só que a string apareça no arquivo,
//      o mesmo tipo de match por substring que `runFocusedVitest` faz contra
//      o `fullName` de verdade.
//
// RED na base: `auditProducersMutants` é um stub que lança na avaliação do
// módulo (`workflow-audit-producers-mutants.ts`) até o commit seguinte
// substituir pelo catálogo real — todo `it` abaixo falha por essa exceção de
// import, não por uma asserção específica.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { replaceExactlyOnce } from "../scripts/mutations/harness.js";
import { auditProducersMutants } from "../scripts/mutations/workflow-audit-producers-mutants.js";

const repoRoot = resolve(import.meta.dirname, "..");

describe("scripts/mutations/workflow-audit-producers-mutants.ts", () => {
  it("tem pelo menos 12 mutantes, todos mechanism family-a, ids únicos", () => {
    expect(auditProducersMutants.length).toBeGreaterThanOrEqual(12);
    const ids = auditProducersMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mutant of auditProducersMutants) {
      expect(mutant.mechanism).toBe("family-a");
      expect(mutant.category.length).toBeGreaterThan(0);
      expect(mutant.edits.length).toBeGreaterThan(0);
    }
  });

  it("toda âncora (edits[].before) ocorre exatamente uma vez, verbatim, no arquivo alvo", () => {
    for (const mutant of auditProducersMutants) {
      for (const edit of mutant.edits) {
        const source = readFileSync(resolve(repoRoot, edit.file), "utf8");
        // `replaceExactlyOnce` lança se a âncora não ocorrer ou ocorrer mais
        // de uma vez — a MESMA checagem que `applyEditExactlyOnce` faz
        // dentro do sandbox do runner de verdade.
        expect(
          () => replaceExactlyOnce(source, edit.before, edit.after, mutant.id),
          `mutante ${mutant.id}, arquivo ${edit.file}`,
        ).not.toThrow();
      }
    }
  });

  it("toda mutação produz um resultado DIFERENTE do original — before !== after aplicado", () => {
    for (const mutant of auditProducersMutants) {
      for (const edit of mutant.edits) {
        const source = readFileSync(resolve(repoRoot, edit.file), "utf8");
        const mutated = replaceExactlyOnce(source, edit.before, edit.after, mutant.id);
        expect(mutated, `mutante ${mutant.id}, arquivo ${edit.file}`).not.toBe(source);
      }
    }
  });

  it("focus.test (título literal) existe verbatim em algum lugar do focus.file", () => {
    for (const mutant of auditProducersMutants) {
      const source = readFileSync(resolve(repoRoot, mutant.focus.file), "utf8");
      expect(
        source.includes(mutant.focus.test),
        `mutante ${mutant.id}: focus.test não encontrado literalmente em ${mutant.focus.file}`,
      ).toBe(true);
    }
  });

  it("focus.file é um dos seis arquivos novos de teste do M7 (identity/leaf/tool/cache/segment/live-tail)", () => {
    const expected = new Set([
      "tests/workflow-audit-identity.test.ts",
      "tests/workflow-audit-leaf.test.ts",
      "tests/workflow-audit-tool.test.ts",
      "tests/workflow-audit-cache.test.ts",
      "tests/workflow-audit-segment.test.ts",
      "tests/workflow-live-tail.test.ts",
    ]);
    const used = new Set(auditProducersMutants.map((mutant) => mutant.focus.file));
    for (const file of used) {
      expect(expected.has(file), `focus.file inesperado: ${file}`).toBe(true);
    }
  });

  it("edits[].file mira só os módulos novos do M7 (audit-producers/audit-runtime/audit-cache/live-tail)", () => {
    const allowed = new Set([
      "src/workflow/audit-producers.ts",
      "src/workflow/audit-runtime.ts",
      "src/workflow/audit-cache.ts",
      "src/workflow/live-tail.ts",
    ]);
    for (const mutant of auditProducersMutants) {
      for (const edit of mutant.edits) {
        expect(allowed.has(edit.file), `edits[].file inesperado: ${edit.file} (${mutant.id})`).toBe(
          true,
        );
      }
    }
  });
});
