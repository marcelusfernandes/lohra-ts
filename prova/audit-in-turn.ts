// Issue #373: `workflow_audit` no mesmo turno que `run_workflow` — remedido
// na base 9a966934 (já carrega #379/#368, "flush-before-release"): o
// cenário `run_workflow → workflow_status(wait) → workflow_audit` já
// devolvia os eventos completos, então o AC 1 só ganha um teste de
// regressão aqui. O AC 2 (dreno travado por um sink permanentemente busy →
// `integrity.pending` no envelope, nunca `events: []` silencioso) é o
// vermelho de fato: `WorkflowTool.auditWithFlush` (tool.ts), chamada pelo
// handler `workflow_audit` de `workflowToolHandlers`, espera o dreno do
// `AuditTrail` (`AuditTrail.flush`/`pendingCount`, audit-trail.ts) por até
// `AUDIT_READ_FLUSH_TIMEOUT_MS` via `WorkflowService.auditPendingAfterFlush`
// (service.ts) antes de consultar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-tool.test.ts"],
} satisfies Declaracao;
