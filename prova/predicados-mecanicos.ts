// Issue #977 (S1 do épico #976): predicados mecânicos sobre o estado do run e a
// costura `FLOW_STRATEGIES`/`FlowDeps`, para que `switch`, `loop`, `escalate` e
// `call` não precisem crescer `engine.ts`.
//
// - `tests/workflow-predicates.test.ts`: os nove predicados do §4 (avaliação
//   total, ausente = null, string JSON, índice de array), as recusas de
//   `validatePredicate` e `readPath` contra `resolveValue("${p}")`.
// - `tests/workflow-flow-seam.test.ts`: `completeness_check` e `checkpoint`
//   rodando pela costura com os hashes de célula pinados, e o `FlowDeps`
//   bastando para escrever os quatro nós seguintes; `validateGate` em
//   `schema-nodes.ts`.
// - `tests/workflow-checkpoint-aninhado.test.ts` e
//   `tests/workflow-cache-stamp.test.ts`: o checkpoint escopado e a fórmula de
//   hash da raiz, sem alteração.
// - `tests/workflow-campos-sem-efeito.test.ts`: o anti-drift lê todo
//   `src/workflow/*.ts` exceto `nodes.ts`.
// - `tests/workflow-schema.test.ts`: o contrato de validação, sem alteração.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-predicates.test.ts",
    "tests/workflow-flow-seam.test.ts",
    "tests/workflow-checkpoint-aninhado.test.ts",
    "tests/workflow-cache-stamp.test.ts",
    "tests/workflow-campos-sem-efeito.test.ts",
    "tests/workflow-schema.test.ts",
  ],
} satisfies Declaracao;
