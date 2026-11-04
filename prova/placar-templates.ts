// Issue #973 (épico #969): placar por template em workflow_templates e na CLI.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-template-stats.test.ts",
    "tests/workflow-templates.test.ts",
    "tests/workflow-command.test.ts",
  ],
} satisfies Declaracao;
