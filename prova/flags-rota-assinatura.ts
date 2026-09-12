// Issue #440: em modo subscription, `--provider` explícito (com ou sem
// `--model`) mandava o modelo alheio direto ao transporte Responses da
// assinatura, que respondia 400. Opção (A), decidida pelo orquestrador:
// recusa fail-fast em `src/commands/chat.ts` (bloco `route.mode ===
// "subscription"`), antes de `resolveCredentials`. Os testes novos em
// chat-subscription-provider-flag.test.ts pinam a recusa (com e sem
// --model) e o caso de não-regressão (--model sozinho continua indo ao
// Codex); chat-subscription-refresh.test.ts continua cobrindo o resto do
// tratamento de erro de refresh que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/chat-subscription-provider-flag.test.ts",
    "tests/chat-subscription-refresh.test.ts",
  ],
} satisfies Declaracao;
