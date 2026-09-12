// Issue #502: seis achados non_blocking de M15 (PRs #488, #493, #496, #497,
// emenda do veredito da PR #507) apontavam disjuntos e envelopes de produção
// sem teste discriminante — nenhum exige mudança em `src/`. Um `it` novo por
// item (steer-tool.ts's disjunto de página vazia, o envelope `pending` de
// collect_session, o flush que faltava nos dois negativos de
// workflow-audit-steered, subId/run-nunca-escrito/pagination_truncated e os
// quatro oráculos de valor de `fieldMarkerRows` em state-audit-repository, e
// os dois mutantes novos de estimated_tokens_to_repay/estimate_basis na
// fatia `supervision`) mais o pino de contagem que sobe de 256/29 para
// 258/31 em `tests/mutations-slices.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-steer-tool.test.ts",
    "tests/orchestration-tools.test.ts",
    "tests/workflow-audit-steered.test.ts",
    "tests/state-audit-repository.test.ts",
    "tests/workflow-cache-preview-writes.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
