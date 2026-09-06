// Declaração de prova da issue #117 (follow-up da #114/PR #116): fecha as
// três lacunas do SKIP "diff só de teste" apontadas no veredito do revisor
// da PR #116 — guarda mais larga que o overlay (fixture), deleção, e o caso
// "teste inteiramente novo, sem produção" (`vacuous-pass` por construção).
// `tests/ci-controle-negativo-lacunas.test.ts` (rodada 2 do revisor da PR
// #119 — `ci-controle-negativo-integracao.test.ts` tinha passado de 800
// linhas) concentra os três casos de integração das lacunas.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/ci-controle-negativo.test.ts",
    "tests/ci-controle-negativo-integracao.test.ts",
    "tests/ci-controle-negativo-lacunas.test.ts",
  ],
} satisfies Declaracao;
