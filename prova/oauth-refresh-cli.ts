// Issue #351: resolveCredentials lançava "no OAuth post configured" sempre
// que o token próprio estava a <300s de expirar, porque nenhum dos 4
// chamadores do CLI (chat, dashboard, chat-boundary, client-pool) passava um
// oauthPost real — a renovação era impossível por construção. Agravante:
// chat.ts:163-165 engolia qualquer erro de resolveCredentials num catch {}
// silencioso e caía em runChatBoundary, que tentava de novo do zero (um
// segundo POST de refresh, com o resultado podendo divergir do primeiro, e
// mensagem genérica escondendo a causa real).
//
// tests/auth-core.test.ts prova que resolveCredentials, sem oauthPost
// explícito, usa por padrão o mesmo fetch real que o login usa
// (defaultOAuthPost) para renovar e persistir o token novo.
// tests/chat-subscription-refresh.test.ts prova que runChat não engole mais
// a falha de refresh: exit != 0, error acionável ("run `lohra auth login`")
// e exatamente uma tentativa de POST de refresh (não duas).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/auth-core.test.ts", "tests/chat-subscription-refresh.test.ts"],
} satisfies Declaracao;
