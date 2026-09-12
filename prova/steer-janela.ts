// Issue #445 (M14, follow-up do épico #421, achado de revisão de M10):
// `workflow_steer` resolvia folhas vivas por `sub_id` lendo só os 100
// eventos mais antigos do run (`AuditRepository.query`'s próprio clamp,
// `src/state/audit-repository.ts:321`) — um run com mais de 100
// `leaf.started` deixava a folha viva fora da janela e devolvia "no live
// leaf" para uma folha que existe de verdade. `tests/workflow-steer-tool
// .test.ts` prova: resolução por `sub_id` funciona com 120 folhas vivas
// plantadas (consulta direta por identidade, nunca a janela de 100), e o
// teto de paginação da resolução por `node_id` (`MAX_RESOLUTION_EVENTS`,
// `src/workflow/steer-tool.ts`) devolve um erro nomeado distinto de "no
// live leaf" quando a janela é truncada.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-steer-tool.test.ts"],
} satisfies Declaracao;
