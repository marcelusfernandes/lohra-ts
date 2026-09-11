// Issue #386: `SAFE_EVENT_TYPES` (`audit-model.ts:104-127`) não pode listar
// `node.started|completed|failed|output` — nenhum produtor deste código os
// emite; o estado/falha de um nó vive em `workflow.node`/`workflow.fault`,
// a pausa em `node.paused` (decisão #368). workflow-audit-live.test.ts prova
// que um `event_type` removido vira `audit.unavailable` na sanitização
// (`publicAuditEvent`) e que as fixtures usam tipos com produtor;
// workflow-audit-identity.test.ts prova o mesmo para as fixtures que
// exercitam `AuditRepository`/`AuditTrail` diretamente.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-live.test.ts", "tests/workflow-audit-identity.test.ts"],
} satisfies Declaracao;
