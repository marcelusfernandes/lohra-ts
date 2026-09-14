// Issue #647 (sub-issue A2 de #637, grupo A itens 1 e 6): mutante do
// re-collect de `engine.ts` (t15, `R1-recollect-fallback-last-wins`) e
// catálogo irmão `scripts/mutations/supervision-mutants-2.ts` (8 mutantes
// N1-N4/V1/W1/X1/Y1 movidos de `supervision-mutants.ts`, que estava no teto
// de 800 linhas). A prova dos mutantes em si (killed/restoreGreen) é
// `npm run mutations:t15` e `npm run mutations:supervision`, coladas no
// test plan da PR — mais lentas que `npm test`, não fazem parte desta
// declaração.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mutations-slices.test.ts",
    "tests/mutations-fixtures-workflow-executor.test.ts",
    "tests/workflow-forced-fallback.test.ts",
  ],
} satisfies Declaracao;
