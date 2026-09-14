// Issue #692: `src/version.ts` (VERSION) é a única fonte da versão do
// pacote em runtime, lida de `package.json`; os sete lugares que a tinham
// escrita à mão (cli.ts, auth/oauth.ts, commands/dashboard.ts,
// doctor/snapshot.ts, gateway/session-service.ts, server/docs.ts,
// server/http-app.ts) importam `VERSION`. `tests/version.test.ts` prova a
// igualdade com `package.json` e a guarda contra literais em `src/**`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/version.test.ts"],
} satisfies Declaracao;
