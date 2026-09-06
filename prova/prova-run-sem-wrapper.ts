// Issue #142 (follow-up da #137): as três chamadas de `spawnSync` em
// `tests/prova-run.test.ts` que ainda spawnavam `node_modules/.bin/tsx`
// (symlink para `tsx/dist/cli.mjs`) passam a lançar via `process.execPath` +
// `--import` com `import.meta.resolve("tsx")` — mesmo molde de
// `tests/helpers/controle-negativo-repo.ts` (issue #137). O meta-teste em
// `ci-controle-negativo-integracao.test.ts` estende sua varredura de
// texto-fonte para incluir `tests/prova-run.test.ts`; `tests/prova-run.test.ts`
// roda sua própria suíte (comportamento idêntico, `argv.slice(2)`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/prova-run.test.ts", "tests/ci-controle-negativo-integracao.test.ts"],
} satisfies Declaracao;
