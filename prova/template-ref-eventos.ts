// Issue #972 (épico #969): template_ref nos eventos plan (live e ledger).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-template-events.test.ts",
    "tests/workflow-audit-live.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
    "tests/workflow-live-tail.test.ts",
  ],
} satisfies Declaracao;
