// Issue #101: chat.ts e dashboard.ts constroem o WorkflowService com `store`
// (productionOwnershipStore, novo em src/workflow/ownership-store.ts) e
// `auditTrail` sobre a connection.database já aberta por cada root — nunca
// uma segunda conexão. Só foi possível depois de #107 (PR #110, em main)
// dar a OrchestrationChildRuntime um installLeafSandbox real; até lá,
// wirear `store` teria regredido run_workflow para sempre recusar
// (LEAF_SANDBOX_UNAVAILABLE) — ver comentário em #101 e o commit
// test(workflow) desta branch.
//
// A prova cobre: a função de holder/ownership store e sua composição com
// OrchestrationChildRuntime (workflow-durable-roots.test.ts); um turno real
// via runChat que dispara run_workflow e grava workflow_run_state/
// workflow_run_spend (workflow-durable-chat.test.ts, AC 3); o mesmo via
// runDashboard sobre o protocolo WS real (workflow-durable-dashboard.test.ts,
// AC 4); e que o wrap do leaf sandbox realmente envolve o dispatch do child,
// não o substitui (orchestration-child-runner.test.ts, sugestão do revisor
// da #110).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-durable-roots.test.ts",
    "tests/workflow-durable-chat.test.ts",
    "tests/workflow-durable-dashboard.test.ts",
    "tests/orchestration-child-runner.test.ts",
  ],
} satisfies Declaracao;
