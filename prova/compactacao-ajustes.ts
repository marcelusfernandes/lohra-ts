// Declaração de prova da issue #287 (achados não bloqueantes do revisor
// rodada 2 da PR #284, épico #230 "Janela de contexto: compactar antes de
// estourar"): contagem já corrigida na #284 (pinada em tests/state-locks.ts,
// aqui só reconfirmada), busca sem duplicatas depois de compactar, erro de
// trava nomeado, eventSink ligado no chat e no gateway ws, e o gateway ws
// resolvendo o perfil real do Codex em vez de null.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-compaction.test.ts",
    "tests/state-locks.test.ts",
    "tests/state-session-repository.test.ts",
    "tests/chat-compaction-events.test.ts",
    "tests/gateway-compaction-events.test.ts",
    "tests/gateway-compaction.test.ts",
  ],
} satisfies Declaracao;
