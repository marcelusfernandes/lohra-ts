// Issue #630 (follow-up da #604, PR #629): `resolveAuthRoute` devolve
// `route.error` quando `preference=subscription` e a assinatura está
// inativa (`src/auth/credentials.ts:157`) -- `runChat` honra isso antes de
// qualquer outra coisa (`src/commands/chat.ts:157`), mas `runDashboard`
// nunca lia `route.error`, só `route.mode`. Este teste prova que o
// dashboard agora recusa a subida com o mesmo stderr do chat, com ou sem
// `--provider`, e que os caminhos existentes (subscription ativa, api_key
// detectado, --provider explícito) continuam verdes.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/gateway/dashboard-command.test.ts"],
} satisfies Declaracao;
