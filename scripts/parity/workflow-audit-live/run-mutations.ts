#!/usr/bin/env node
// Shim histórico (issue #150, passo 13-S3 do épico #13): os 32 mutantes
// migraram para `scripts/mutations/workflow-audit-live.ts`, sem o
// ORACLE_SHA hardcoded do Python e sem depender deste diretório de
// paridade. `npm run mutations:t17` já aponta para o caminho novo; este
// arquivo só existe para quem ainda chama o caminho antigo direto.
console.error(
  "scripts/parity/workflow-audit-live/run-mutations.ts foi descontinuado (issue #150); " +
    "use `npm run mutations:t17` (scripts/mutations/workflow-audit-live.ts).",
);
process.exitCode = 1;
