// Declaração de prova da issue #236 (collectLeaf gateia a folha única pela
// mesma estimativa afordável que o fan-out já usa — via
// Budget.affordableLeaves(measuredOnly) — antes de disparar, sem regredir o
// caso sem medição nem o caso sem token_budget).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-executor.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
