// Issue #650 (épico #637, grupo B, itens 11-13): `addUsage` único (módulo
// folha `src/conversation/usage.ts`), `partialCalls` em
// `ConversationCancelledError` para o cancel em voo, e `errorEnvelope` com o
// mesmo `extra` aditivo (aux_calls/usage_total) que `successEnvelope` já
// tinha, mais `stage=` no evento `title.failed`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-envelope.test.ts",
    "tests/conversation-usage.test.ts",
    "tests/chat-compaction-events.test.ts",
    "tests/orchestration-child-runner-abort.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/client-pool-aux.test.ts",
    "tests/mutations-slices.test.ts",
    "tests/mutations-t23-catalog.test.ts",
  ],
} satisfies Declaracao;
