// Declaração de prova da própria issue #42 (dogfooding do harness).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/prova-slug.test.ts",
    "tests/prova-resumo.test.ts",
    "tests/prova-vitest-relatorio.test.ts",
    "tests/prova-run.test.ts",
    "tests/prova-run-validacao.test.ts",
  ],
} satisfies Declaracao;
