// Issue #620 (follow-up do veredito da PR #617, épico #575): resumo pelo
// AuxClient usa o mesmo orçamento de saída que o summarizer default.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/client-pool-aux.test.ts",
    "tests/conversation-compaction-verbatim.test.ts",
    "tests/chat-compaction-events.test.ts",
  ],
} satisfies Declaracao;
