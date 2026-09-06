// Issue #102: `WorkflowService.shutdown()` para heartbeat e auto-resume,
// espera (limitado) cada run vivo assentar — para que o release de lease e a
// escrita da linha terminal do próprio run rodem com a conexão AINDA aberta,
// em vez de correr depois contra uma já fechada (o "lease release failed"
// visto em produção) — e então descarrega o `auditTrail`. `chat.ts` e
// `dashboard.ts` chamam `shutdown()` entre `imageGenerator?.close()` e
// `connection.close()`. O ramo efêmero (`store === undefined`, service.ts)
// ganha um aviso único fora de ambiente de teste, mantendo o caminho de
// testes unitários que constroem `WorkflowService` sem `store`.
//
// A prova cobre: idempotência, timer de heartbeat morto após shutdown(),
// resume via `resume_run_id` sem `busyErrorMessage` depois do shutdown, o
// audit trail recusando `record()` após `shutdown()`, e a decisão do ramo
// efêmero (`tests/workflow-shutdown.test.ts`); e que nada na suíte de
// durabilidade existente regrediu (`tests/workflow-service-durability.test.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-shutdown.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
