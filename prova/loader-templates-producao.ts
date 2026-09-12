// Issue #464 (M11-S6, épico #458): liga o loader de templates do operador
// em produção (`chat.ts`/`dashboard.ts`) e troca o `failSafe` de
// `workflow_templates` por um handler real. `tests/workflow-templates.test.ts`
// cobre o módulo novo (`src/workflow/templates.ts`): `templateLoader`,
// `listTemplates`, a recusa de `ref` inválido na carga via `WorkflowService`
// (construído como `chat.ts`, com o loader real), e `workflowTemplatesHandler`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-templates.test.ts"],
} satisfies Declaracao;
