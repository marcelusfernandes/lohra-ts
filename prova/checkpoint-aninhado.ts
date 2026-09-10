// Declaração de prova da issue #243 (checkpoint em template aninhado não
// colide com o do pai): `runCheckpoint` (src/workflow/engine.ts) agora
// chaveia por um id ESCOPADO (`<sub_node_id>.<checkpoint_id>`, escopo vazio
// na raiz) em vez do `node.id` cru — a raiz do #243 era `checkpointAnswers`
// compartilhado sem alteração com o motor aninhado (`runNested`,
// engine.ts:853-869), então uma resposta crua batia nos dois checkpoints
// que compartilham o mesmo id (o caso comum: "confirm" no pai e no filho).
// `nestedCheckpointAnswers`/`resolveCheckpoint` (engine-utils.ts) marcam a
// colisão com um sentinela e recusam — nunca aplicam — a resposta crua
// quando ambígua; o payload da pausa e o `CHECKPOINT_HINT`
// (src/workflow/service.ts) passam a citar a forma escopada.
// `tests/workflow-checkpoint-aninhado.test.ts` é o arquivo novo (nem
// `tests/workflow-nodes-tool.test.ts` nem `tests/workflow-service-durability.test.ts`
// precisaram crescer): cobre a colisão resolvida por chaves escopadas, a
// recusa nomeada de um id cru colidente (engine e retomada durável via
// `WorkflowService`), a compatibilidade de um id cru sem colisão, e o
// `CHECKPOINT_HINT` citando a forma escopada.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-checkpoint-aninhado.test.ts"],
} satisfies Declaracao;
