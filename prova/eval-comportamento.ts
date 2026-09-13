// Issue #576 (épico #575): harness de eval de comportamento sobre o stub —
// `scripts/eval/{types,case,oracles,session,runner,results,run}.ts` são o
// que estes testes provam.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/eval-runner.test.ts", "tests/eval-cases.test.ts"],
} satisfies Declaracao;
