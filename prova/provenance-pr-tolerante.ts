// Issue #160 (slug da branch: provenance-pr-tolerante): job `provenance` estrito em push, tolerante a `pending` em PR,
// com resumo `--json` no step summary.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-provenance-job.test.ts", "tests/ci-workflow-order.test.ts"],
} satisfies Declaracao;
