// Issue #477: guarda fail-closed de `pagedSubIds` (steer-tool.ts) e
// paginação em SQL de `AuditRepository.query` (audit-repository.ts).
// `tests/workflow-steer-tool.test.ts` cobre a guarda (`truncated: true` para
// uma página incompleta) e o orçamento exato de `MAX_RESOLUTION_EVENTS`;
// `tests/state-audit-repository.test.ts` (novo, oráculo de equivalência) e
// `tests/workflow-audit-tool.test.ts` (pinos existentes, intocados) cobrem
// o envelope da query paginada.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-steer-tool.test.ts",
    "tests/state-audit-repository.test.ts",
    "tests/workflow-audit-tool.test.ts",
  ],
} satisfies Declaracao;
