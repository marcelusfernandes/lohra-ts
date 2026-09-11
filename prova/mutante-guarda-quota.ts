// Issue #418 (M8-11, épico #396): veredito da PR #416 (#412) apontou que o
// mutante `Q1-quota-guard-removed` (âncora original
// `src/workflow/engine-utils.ts:490`, `if (collected.errorKind !==
// QUOTA_EXHAUSTED) recordFaultKind(...)`) não entrava na fatia
// `workflow-executor` porque `focalTests` de `workflow-executor-mutants.ts`
// não incluía `tests/workflow-fault-kinds.test.ts` e
// `tests/mutations-slices.test.ts:434` pina a igualdade entre `focalTests`
// e `slices.json#focusFiles`. `tests/mutations-slices.test.ts` prova a
// contagem (t15 44 → 45; total 226 → 227) e a igualdade das duas listas;
// `tests/workflow-fault-kinds.test.ts` continua sendo o oráculo que mata o
// mutante quando `npm run mutations:t15` roda de verdade (fora do vitest).
// `service.ts:115` também estreita `prior_fault_kinds` para `ErrorKind[]`
// agora que `service.ts:158` já filtra por `isErrorKind` — sem teste novo,
// crescimento zero de linhas. Issue #426 re-ancorou o mutante em
// `engine-utils.ts:487` (`!pausesRun(...)`, generalizado para os kinds de
// rota) — mesmo id, mesmo oráculo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts", "tests/workflow-fault-kinds.test.ts"],
  check: true,
} satisfies Declaracao;
