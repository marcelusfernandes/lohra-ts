// Issue #107: OrchestrationChildRuntime instala o sandbox de leaf exigido
// pelo caminho durável (opção A — sem mudar tipos em runtime.ts/sandbox.ts/
// service.ts). A prova cobre o runtime novo, o wiring em child-runner.ts (com
// os testes existentes de createChildRunner, que devem seguir passando sem
// edição) e a suíte de durabilidade do WorkflowService, que continua
// exercitando o mesmo contrato fail-closed sem regressão.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-orchestration-runtime.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/workflow-service-durability.test.ts",
  ],
} satisfies Declaracao;
