#!/usr/bin/env node
// Shim: este runner foi substituído por `scripts/mutations/web-tools.ts`
// (issue #152, passo 0e do épico #13) — mecânica A do harness comum, sem
// `resolveOracleWorkspace`, `runScenario`, `parseScenarioManifest` nem os
// manifests de `scripts/parity/manifests/t20/**`. O script `mutations:t20`
// aponta para o runner novo; `parity:t20:mutations` foi removido do
// `package.json`. Este arquivo fica só como referência histórica (não é
// mais executado por nenhum script npm) e sai com falha se alguém o chamar
// direto, para não fingir que ainda prova alguma coisa.
import process from "node:process";

process.stderr.write(
  "scripts/parity/web-tools/run-mutations.ts foi substituído por " +
    "`npm run mutations:t20` (scripts/mutations/web-tools.ts, issue #152). " +
    "Este shim não roda mutação nenhuma.\n",
);
process.exitCode = 1;
