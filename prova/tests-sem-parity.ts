// Issue #166 (épico #8): migra para tests/support/** e tests/fixtures/** o
// que `tests/` ainda importa/lê de `scripts/parity/**` além da classe A (o
// próprio harness de paridade, que #167 apaga junto com o resto do
// diretório). `tests-sem-parity.test.ts` prende o AC1 (grep vazio fora da
// whitelist); `t22-closeout.test.ts` e `scenarios.test.ts` continuam
// declarados aqui porque são os dois testes de produto mais acoplados ao
// harness antes desta migração; `launch-candidate.test.ts` prova que o
// `git mv` de gateway/{launch-candidate,raw-http-client,raw-ws-client} não
// quebrou o teste [processo-ts]+[socket-bilateral] mais caro da suíte.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tests-sem-parity.test.ts",
    "tests/parity/scenarios.test.ts",
    "tests/t22-closeout.test.ts",
    "tests/gateway/launch-candidate.test.ts",
  ],
} satisfies Declaracao;
