// Issue #428: SIGTERM/SIGINT gravam segment.completed {reason: "signal"},
// distinto de um cancel — `WorkflowService.shutdown("signal")` marca cada
// run vivo (`RunRecord.interruptCause`) antes de cancelá-lo, e a causa
// atravessa `runShutdown` → `cancelAndSettle` → `announceStretchEnd` →
// `announceSegmentCompleted` (audit-producers.ts). `cancel(runId)` e um
// `shutdown()` sem razão continuam publicando `status: "cancelled"`, agora
// com `reason: "cancelled"` explícito no payload — nunca `reason: "signal"`.
// `registerShutdownTrigger` (src/cli/shutdown-trigger.ts, novo) registra o
// mesmo handler para os dois sinais via `process.once` e devolve
// `unregister`; `serve.ts`/`dashboard.ts` passam a usá-lo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-shutdown-signal.test.ts"],
} satisfies Declaracao;
