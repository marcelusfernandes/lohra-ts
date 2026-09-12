// Issue #540: limpeza pós-M18 — comentários falsos em
// audit-model/cache-preview/accounting/mutations-matrix, oráculo do canário
// de rawMarker, e os dois `it`s de precedência upstream_missing sobre
// token_budget_exhausted. O item 6 (parallel/budget) e o mutante de
// normalizeResumeId (itens 6/f, 5) não reproduzem/ficam fora de escopo —
// ver comentários na issue #540 (2026-09-12): itens 7-9 citam arquivos fora
// de `## Files`; o mutante exigiria `scripts/mutations/slices.json`,
// também fora de `## Files`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-model.test.ts", "tests/workflow-cache-preview-budget.test.ts"],
} satisfies Declaracao;
