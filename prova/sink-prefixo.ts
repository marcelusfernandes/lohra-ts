// Declaração de prova da issue #143 (mutação sobrevivente do `qa` da PR
// #139, mutação (c): prende o formato exato do aviso de
// `productionWarningSink` e a entrada de catálogo correspondente em
// `mutants-orchestration.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-durable-roots.test.ts", "tests/workflow-progress-fence.test.ts"],
} satisfies Declaracao;
