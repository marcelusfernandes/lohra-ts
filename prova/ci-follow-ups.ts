// Declaração de prova da issue #78 (follow-ups do controle-negativo e do
// summary unificado com contratos — issue #69 seção 2, revisões das PRs
// #64/#67).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts", "tests/ci-contratos.test.ts"],
} satisfies Declaracao;
