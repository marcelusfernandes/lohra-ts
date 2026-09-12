// Issue #511 (follow-up de #498, PR #507, veredito non_blocking 1): a
// re-sanitização de publicAuditEvent (rawMarker/safeValue,
// audit-model.ts) não era idempotente em tamanho — um marcador já
// gravado sofria uma segunda passada que o reembrulhava, podia crescer
// acima de AUDIT_EVENT_BYTES e re-derivar como audit.truncated numa
// linha que event_markers/notices (audit-repository.ts, filtro por
// COLUNA event_type) nunca contavam. tests/workflow-audit-model.test.ts
// prova a idempotência de safeAuditMetadata/publicAuditEvent e a
// reprodução exata do revisor; tests/state-audit-repository.test.ts
// prova que a página e os marcadores concordam de novo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-model.test.ts", "tests/state-audit-repository.test.ts"],
} satisfies Declaracao;
