// Issue #971 (épico #969): run_workflow {template} e a origem durável do run.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-run-template.test.ts", "tests/state-migrations.test.ts"],
} satisfies Declaracao;
