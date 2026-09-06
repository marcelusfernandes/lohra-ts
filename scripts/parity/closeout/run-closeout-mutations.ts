#!/usr/bin/env node
// Shim (issue #153, passo 0f do épico #13): dos 35 mutantes deste
// agregador, 8 miravam `src/` e migraram para
// `scripts/mutations/self-update.ts` (`npm run mutations:self-update`,
// sobre o harness comum de `scripts/mutations/harness.ts`, sem workspace do
// oracle Python injetado). Os outros 27 miravam artefato exclusivo do
// processo de closeout T22 (o próprio diretório `scripts/parity/closeout/`,
// outros scripts do diretório histórico de paridade, ou `README.md`/
// `package.json` sobre esse processo) e foram aposentados com registro —
// quadro completo em `docs/regression-inventory.md`. `mutations:closeout`
// saiu do `package.json`; este arquivo fica só como referência histórica
// (o #167 apaga o diretório inteiro) e sai com falha se alguém o chamar
// direto, para não fingir que ainda prova alguma coisa.
import process from "node:process";

process.stderr.write(
  "run-closeout-mutations.ts foi aposentado (issue #153): os 8 mutantes de " +
    "src/ migraram para `npm run mutations:self-update` " +
    "(scripts/mutations/self-update.ts); os outros 27 miravam artefato do " +
    "processo de closeout T22 e foram aposentados com registro em " +
    "docs/regression-inventory.md. Este shim não roda mutação nenhuma.\n",
);
process.exitCode = 1;
