// Declaração de prova da issue #117 (follow-up da #114/PR #116): fecha as
// três lacunas do SKIP "diff só de teste" apontadas no veredito do revisor
// da PR #116 — guarda mais larga que o overlay (fixture), deleção, e o caso
// "teste inteiramente novo, sem produção" (`vacuous-pass` por construção).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts", "tests/ci-controle-negativo-integracao.test.ts"],
} satisfies Declaracao;
