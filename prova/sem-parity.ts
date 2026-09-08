// Issue #167 (épico #8): remove os scripts `parity:*`/`probe:*`/`smoke:*` de
// `package.json` e apaga `scripts/parity/` inteiro (classe A de #166, que só
// deixava a classe B — o que `tests/` de produto ainda usa — migrada para
// `tests/support/**`/`tests/fixtures/**`). `tests-sem-parity.test.ts` (de
// #166) ganha aqui o pino de que o diretório histórico não existe mais e que
// nenhum script de `package.json` aponta para ele; `ci-contratos.test.ts` e
// `t22-docs.test.ts` são a Proof original da issue.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/t22-docs.test.ts", "tests/ci-contratos.test.ts", "tests/tests-sem-parity.test.ts"],
} satisfies Declaracao;
