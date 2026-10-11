import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/ci-controle-negativo-integracao.test.ts",
    "tests/ci-controle-negativo-lacunas.test.ts",
    "tests/ci-controle-negativo.test.ts",
  ],
} satisfies Declaracao;
