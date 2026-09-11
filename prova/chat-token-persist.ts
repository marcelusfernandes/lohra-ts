// Declaração de prova da issue #357: `chat.ts:~178` intercepta também
// `TokenPersistError` (refresh OK, `writeTokens` falhou) como
// `RefreshFailedError` — sem isso, o erro caía em `runChatBoundary`, que
// chamava `resolveCredentials` de novo com o refresh_token já rotacionado
// (o antipadrão de duplo-POST que #351 corrigiu para `RefreshFailedError`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/chat-subscription-refresh.test.ts"],
} satisfies Declaracao;
