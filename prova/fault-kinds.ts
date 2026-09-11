// Issue #399 (M8-2, épico #396): `RunResult.faultKinds` (accounting.ts),
// `fault_kinds` no rollup vivo (service-rollup.ts) e `prior_fault_kinds`/
// `fault_kinds_total` no durável (service.ts) — aditivo a `faults`, que
// continua byte-idêntico.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-fault-kinds.test.ts"],
} satisfies Declaracao;
