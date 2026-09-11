// Issue #390: `parseAuditQuery` (`src/workflow/audit-query.ts:35-38`) tratava
// "" nos quatro filtros de string e `attempt: 0` como filtro ATIVO em vez de
// ausência — um chamador com schema estrito (Codex `strict: true`) preenche
// todo o schema, então `node_id`/`event_type`/`sub_id`/`segment_id` chegam ""
// e `attempt` chega 0, e a query resultante filtra por um valor que nunca
// bate contra o ledger, devolvendo `events: []` mesmo com eventos gravados
// (dogfooding da PR #389/#373, veredito do revisor). `tests/
// workflow-audit-query.test.ts` prova o parser isolado e o handler real
// `workflow_audit` (sqlite real) com os opcionais em ""/0.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-query.test.ts"],
} satisfies Declaracao;
