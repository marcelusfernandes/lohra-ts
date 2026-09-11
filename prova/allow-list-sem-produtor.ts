// Issue #386: `SAFE_EVENT_TYPES` (`audit-model.ts:104-127`) não pode listar
// `node.started|completed|failed|output` — nenhum produtor deste código os
// emite; o estado/falha de um nó vive em `workflow.node`/`workflow.fault`,
// a pausa em `node.paused` (decisão #368). workflow-audit-allow-list.test.ts
// prova que um `event_type` removido vira `audit.unavailable` na sanitização
// (`publicAuditEvent`) — arquivo próprio, não workflow-audit-live.test.ts,
// para não fazer um arquivo já acima de 800 linhas na base crescer (regra
// `arquivo-grande` do check `contratos`). workflow-audit-live.test.ts e
// workflow-audit-identity.test.ts provam que as fixtures usam tipos com
// produtor.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-audit-allow-list.test.ts",
    "tests/workflow-audit-live.test.ts",
    "tests/workflow-audit-identity.test.ts",
  ],
} satisfies Declaracao;
