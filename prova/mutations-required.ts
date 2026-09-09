// Issue #225: mutations.yml sem filtro de paths e com job-resumo `mutations`
// de nome fixo, required no ruleset.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-mutations-workflow.test.ts"],
} satisfies Declaracao;
