// Issue #394: a descrição de `workflow_audit` (builtin-definitions.ts:~573)
// atribuía `integrity.pending` a "this run's own events" — mas
// `AuditTrail.pendingCount()` (audit-trail.ts:124-126) soma fila + em voo
// do trail inteiro do processo, sem filtrar por run_id. A frase agora diz
// que a contagem é do processo (qualquer run), coerente com o código e com
// `docs/workflow-audit.md` (seção `integrity.pending`, já correta desde a
// PR #393). tests/builtin-definitions-audit-description.test.ts prova as
// duas pontas: contém "any run" e não contém mais "this run's own events".
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/builtin-definitions-audit-description.test.ts"],
} satisfies Declaracao;
