// Issue #156 (13-S9): workflow `mutations.yml` filtrado por path via
// `scripts/github/mutations-matrix.ts` + `scripts/mutations/slices.json`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-mutations-workflow.test.ts", "tests/ci-workflow-order.test.ts"],
} satisfies Declaracao;
