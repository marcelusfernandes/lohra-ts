// Issue #583 (épico #575, P7): prompt do subagente com ambiente, lista de
// tools e contrato de retorno. O que este slug prova (AC da issue):
// buildSubagentSystemPrompt carrega Environment/lista de tools (derivada de
// childToolDefinitions)/sentinela de retorno; outcome aditivo em
// delegate_task/collect_session, chaves existentes intocadas; sentinela
// ausente vira outcome: null, sem alterar status/error_kind.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-subagent-prompt.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/orchestration-tools.test.ts",
  ],
} satisfies Declaracao;
