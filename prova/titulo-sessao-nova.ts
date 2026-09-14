// Issue #623: título de sessão nova via AuxClient rodava DEPOIS de runTurn
// fechar o transporte — CLIENT_CLOSED engolido pelo catch fail-open,
// aux_calls nunca chegava a contar o título e nenhuma sessão nova ganhava
// título. `chat-compaction-events.test.ts` prende o caso feliz (aux_calls:
// 1, título persistido, sem `title.failed`) e o caminho de falha real
// (fail-open, evento nomeado, turno não derruba); `client-pool-aux.test.ts`
// é o regressivo do `AuxClient`/`ClientPool` que esta issue não deveria
// quebrar (nenhuma mudança em `src/agent/aux.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/chat-compaction-events.test.ts", "tests/client-pool-aux.test.ts"],
} satisfies Declaracao;
