// Issue #6 AC 4: o job `checks` do CI roda `test` antes de `build`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-workflow-order.test.ts"],
} satisfies Declaracao;
