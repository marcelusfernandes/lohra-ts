// Issue #368: `auditedWorkflowCache` publica `cache.replayed/missed/stored/
// unavailable`; `audit-producers.ts` ganha `segment.started/completed`,
// `node.paused` e `announceProcessCrash` (dead-owner resume); o emenda do
// orquestrador (2026-09-11) também corrige um bug pré-existente — nenhum
// evento terminal de um run durável chegava ao ledger, porque
// `finishStretch()` liberava a lease antes do dreno assíncrono do
// `AuditTrail` — e torna toda recusa de fence nomeada (nunca `null`
// silencioso). tests/workflow-audit-cache.test.ts e
// tests/workflow-audit-segment.test.ts provam o contrato novo através de
// `WorkflowService` + `SqliteWorkflowCache`/`AuditRepository` reais;
// tests/workflow-audit-identity.test.ts ganha o teste de regressão do bug
// de fence (workflow.done/segment.completed chegam ao ledger; dead-owner →
// process_crash sob a fence nova); tests/workflow-audit-live.test.ts só
// ajusta a asserção da sequência pinada (ganha segment.*).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-audit-cache.test.ts",
    "tests/workflow-audit-segment.test.ts",
    "tests/workflow-audit-identity.test.ts",
    "tests/workflow-audit-live.test.ts",
  ],
} satisfies Declaracao;
