// Issue #137: os três helpers de teste que spawnavam `tsx` pelo wrapper
// `tsx/dist/cli.mjs` (direto ou via o shim `node_modules/.bin/tsx`, symlink
// para o mesmo `cli.mjs`) passam a lançar via `process.execPath` +
// `--import` com `import.meta.resolve("tsx")` — molde de
// `scripts/parity/gateway/launch-candidate.ts` (issue #132). O meta-teste
// em `ci-controle-negativo-integracao.test.ts` escaneia o texto-fonte dos
// três arquivos-alvo; os outros dois rodam a própria suíte de cada um.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/ci-contratos.test.ts",
    "tests/ci-escopo.test.ts",
    "tests/ci-controle-negativo-integracao.test.ts",
  ],
} satisfies Declaracao;
