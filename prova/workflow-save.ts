// Issue #970 (épico #969): workflow_save guarda como template o spec de um run complete.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-template-save.test.ts", "tests/workflow-templates.test.ts"],
} satisfies Declaracao;
