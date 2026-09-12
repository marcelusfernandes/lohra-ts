// Issue #518 (M16-S3, épico #490, ADR 0005): cancel/timeout/shutdown abortam
// o stream em voo; o turno parcial vira `interrupted{cancelled, partial}`
// com tokens estimados. `estimatePartialUsage` (token-estimate.ts),
// `isAbortOf`/`ConversationCancelledError.partialUsage` (runtime.ts/errors.ts),
// `child-runner.ts`'s catch, `OrchestrationChildRuntime.cancel`'s ceiling e
// `AuditedChildRuntime.cancel`'s sonda pós-assentamento (audit-runtime.ts)
// são o que estes testes provam.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-runtime.test.ts",
    "tests/orchestration-child-runner-abort.test.ts",
    "tests/workflow-abort-in-flight.test.ts",
    "tests/context-estimate.test.ts",
    "tests/orchestration-core-shutdown.test.ts",
  ],
} satisfies Declaracao;
