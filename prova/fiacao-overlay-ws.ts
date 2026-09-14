// Issue #651 (sub-issue C1 de #637): fia GatewayWsDeps.notices (#608 AC4) e
// GatewayWsDeps.summarize (#587 AC1) no único caller de produção
// (`dashboard.ts`). `tests/gateway/dashboard-ws-overlay.test.ts` prova o
// CALLER com `runDashboard` real; `tests/gateway/ws-connection-notices.
// test.ts` continua provando o mecanismo isolado (byte-identical quando os
// dois campos estão ausentes); `tests/dashboard-prompt-caching.test.ts`
// guarda o caminho do cron (hoisting de `createTurnNoticesPort` não pode
// mudar o comportamento do job runner); `tests/mutations-slices.test.ts`
// prova a contagem/tabela de mutantes.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/gateway/dashboard-ws-overlay.test.ts",
    "tests/gateway/ws-connection-notices.test.ts",
    "tests/dashboard-prompt-caching.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
