// Issue #232: uma folha cujo `usage` nunca foi medido (morreu antes de
// reportar, erro de provedor, erro de resolução) entrava no orçamento como
// zero, sem marca — indistinguível de uma folha que genuinamente gastou
// zero tokens. child-runner.ts agora devolve `usageUncertain: true` nesses
// três caminhos; ChildResult/CollectResult propagam; RunResult conta
// `usageUncertainLeaves`, exposto em workflow_status como
// `usage_uncertain_leaves`; Budget.estimatedLeafCost exclui folhas incertas
// da média; collect_session ganha `usage_uncertain` como 14ª chave.
//
// orchestration-child-runner.test.ts pina os três caminhos sem medição (mais
// o caso de controle, uma folha medida). orchestration-tools.test.ts repina
// o envelope de collect_session para 14 chaves. workflow-executor.test.ts
// prova Budget.estimatedLeafCost e RunResult.usageUncertainLeaves de ponta a
// ponta pelo WorkflowEngine, e usage_uncertain_leaves em workflow_status
// (service.ts's resultView) — não em workflow-service-durability.test.ts:
// esse arquivo já passa de 800 linhas na base, então o teste novo de
// WorkflowService foi para cá (ambos em `Files`), sem crescer um arquivo já
// no teto. orchestration-core-delegate.test.ts continua verde, sem
// regressão no batch de delegate_task.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-child-runner.test.ts",
    "tests/orchestration-tools.test.ts",
    "tests/workflow-executor.test.ts",
    "tests/orchestration-core-delegate.test.ts",
  ],
} satisfies Declaracao;
