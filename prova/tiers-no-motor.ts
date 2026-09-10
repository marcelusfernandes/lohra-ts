// Issue #258: o mapa de tiers do operador nunca chegava ao WorkflowEngine —
// WorkflowService resolvia via tiersLoader (fail-closed, #234) mas construía
// os dois WorkflowEngine (launch, launchDurable) sem `tiers`, então um nó com
// `tier: "big"` sempre rodava com o modelo da sessão. Os testes novos em
// workflow-tiers.test.ts inspecionam o `model` pedido à folha em start() e em
// resume(); workflow-service-durability.test.ts continua cobrindo o resto do
// contrato de durabilidade que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tiers.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
