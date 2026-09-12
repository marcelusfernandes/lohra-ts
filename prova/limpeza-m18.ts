// Issue #540: limpeza pós-M18 — comentários falsos em
// audit-model/cache-preview/accounting/mutations-matrix/engine/audit-runtime/
// builtin-definitions, oráculo do canário de rawMarker, os dois `it`s de
// precedência upstream_missing sobre token_budget_exhausted, e o mutante
// V1-normalize-resume-id-trim-off-by-one (item 5, `supervision-mutants.ts`).
//
// Item 6 (parallel/budget) não reproduz — ver comentário na issue #540
// (2026-09-12): tests/workflow-cache-preview-budget.test.ts converte a
// investigação em contra-asserção que trava o comportamento já correto.
//
// tests/mutations-slices.test.ts prende os pinos 268/37; a prova do
// mutante em si (killed/restoreGreen) é `npm run mutations:supervision`,
// fora do harness de vitest desta declaração (gate próprio, ver Test plan
// da PR).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-audit-model.test.ts",
    "tests/workflow-cache-preview-budget.test.ts",
    "tests/orchestration-tools.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
