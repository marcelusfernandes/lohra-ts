// Issue #383: fecha sete lacunas de mutação que o veredito da PR #382 e três
// emendas do orquestrador (PRs #384/#380, #386, #385) registraram —
// `R6-drop-newest` (FIFO do ring do live tail), `L4-wait-false-closes`
// (`collect()` com `wait:false`), `W1-watch-events-repeat` (cursor do
// `watch --events`), `M1-allowlist-free-string` (a checagem da allow-list
// de `event_type`, não seu conteúdo), `W2-audit-trail-warning-unwired` (a
// fiação `{ warning: auditWarning }` do `AuditTrail` de `chat.ts`),
// `T3-cancel-flush-skipped` (o laço de flush de `close()`) e
// `PD-pending-never-reported` (o relato de `pending` de `workflow_audit`) —
// mais dois testes de regressão sem mutante novo (settle tardio depois de
// `close()`, `pending.count` por `sub_id` entre duas folhas). Nada em
// `src/**`: só testes, catálogo de mutação e docs.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-live-tail.test.ts",
    "tests/workflow-audit-leaf.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
    "tests/workflow-audit-tool-cancel.test.ts",
    "tests/chat-audit-trail-wiring.test.ts",
    "tests/mutations-fixtures-workflow-audit.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
