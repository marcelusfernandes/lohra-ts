// Issue #365: segment_id por acquisition, publicado nos eventos de audit e
// persistido em workflow_run_state.audit_segment_id. tests/workflow-audit-
// identity.test.ts prova o contrato novo (identidade, resume, causalContext,
// fail-closed sob perda de posse, flush no shutdown); workflow-audit-live
// continua cobrindo o resto do contrato de audit/live que a extração de
// forwardEvent/announcePlan/announceDone para audit-producers.ts não pode
// quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-identity.test.ts", "tests/workflow-audit-live.test.ts"],
} satisfies Declaracao;
