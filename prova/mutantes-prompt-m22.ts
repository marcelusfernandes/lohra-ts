// Issue #646 (sub-issue A1 de #637): mutantes de doutrina, moldura de
// memória/perfil/instruções, snapshot de git e resumo — catálogo novo
// `scripts/mutations/context-prompt-mutants.ts` (fatia `context-window`),
// mais um mutante de fiação em `self-update-mutants.ts` (dashboard.ts) e um
// em `orchestration.ts` (subagent-prompt.ts). A prova dos mutantes em si
// (killed/restoreGreen) é `npm run mutations:t23`, `mutations:self-update` e
// `mutations:t16`, coladas no test plan da PR — mais lentas que `npm test`,
// não fazem parte desta declaração.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mutations-slices.test.ts",
    "tests/mutations-t23-catalog.test.ts",
    "tests/mutations-self-update-catalog.test.ts",
    "tests/context.test.ts",
  ],
} satisfies Declaracao;
