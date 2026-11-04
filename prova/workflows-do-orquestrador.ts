// Épico #969: o orquestrador guarda e reusa os workflows que constrói (#970-#973).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-template-save.test.ts",
    "tests/workflow-templates.test.ts",
    "tests/workflow-run-template.test.ts",
    "tests/workflow-template-events.test.ts",
    "tests/workflow-template-stats.test.ts",
    "tests/state-migrations.test.ts",
    "tests/builtin-definitions-budget.test.ts",
    "tests/session-tools.test.ts",
  ],
} satisfies Declaracao;
