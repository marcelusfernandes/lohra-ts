// Issue #608 (follow-up dos achados non_blocking da PR #606, épico #575
// P13): overlay persistido no histórico (AC1), kind do turno morto
// classificado por classifyProviderError (AC2), invariante 1 pinado byte a
// byte com aviso presente (AC3), overlay disponível também no gateway WS
// (AC4). `tests/conversation-runtime-notices.test.ts` prova AC1/AC3/os
// menores de commitTurn; `tests/context-notices-overlay.test.ts` prova AC2
// e o escape do marcador forjado; `tests/state-notices-repository.test.ts`
// prova a mensagem de recusa de escopo atualizada;
// `tests/gateway/ws-connection-notices.test.ts` prova AC4.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-runtime-notices.test.ts",
    "tests/context-notices-overlay.test.ts",
    "tests/state-notices-repository.test.ts",
    "tests/gateway/ws-connection-notices.test.ts",
  ],
} satisfies Declaracao;
