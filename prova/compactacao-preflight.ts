// Declaração de prova da issue #252 (compactação preflight sob trava, com
// latch contra compactação fútil — última sub-issue do épico #230 "Janela
// de contexto: compactar antes de estourar").
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-compaction.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/conversation-envelope.test.ts",
    "tests/context-estimate.test.ts",
    "tests/state-locks.test.ts",
    "tests/gateway/session-service.test.ts",
  ],
} satisfies Declaracao;
