// Declaração de prova da issue #587 (epic #575, P11): compactação e título
// pelo AuxClient — summarize/title injetados em chat/dashboard, fallback ao
// summarizer padrão com evento nomeado, aux_calls aditivo no envelope
// --json, título persistido e devolvido por session_search browse, e o
// "Acréscimo do orquestrador" (maxTranscriptTokens da janela real, aviso de
// truncamento via eventSink, headAlignedKeepCount nunca separa tool_calls
// do tool).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/client-pool-aux.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/conversation-runtime-aux.test.ts",
    "tests/conversation-envelope.test.ts",
    "tests/conversation-compaction.test.ts",
    "tests/conversation-compaction-transcript.test.ts",
    "tests/conversation-compaction-verbatim.test.ts",
    "tests/state-session-repository.test.ts",
  ],
} satisfies Declaracao;
