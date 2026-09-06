// Issue #138 — follow-up to #125's PR #133 (`prova/progress-intermediario.ts`):
// prende os dois sobreviventes que o `qa` daquela PR relatou (predicado
// `event.state !== "running"` -> `true`, e `tainted` forçado a `false` só na
// escrita intermediária). O novo arquivo pequeno vai junto dos dois que a
// issue original já declarava — nenhum dos dois foi tocado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-progress-fence.test.ts",
    "tests/workflow-cross-process.test.ts",
    "tests/workflow-progress-cobertura.test.ts",
  ],
} satisfies Declaracao;
