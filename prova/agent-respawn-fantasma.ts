// Issue #321: `runAgent` (engine.ts:448-461) creditava um respawn a
// `leafRespawns` antes de saber se a próxima tentativa realmente ia
// spawnar — o mesmo atalho pausado de `collectLeaf` (engine.ts:235-236) que
// `stillDying` (engine-utils.ts) já guarda para `parallel` desde #315.
// `tests/workflow-agent-retries.test.ts` cobre o caso novo (pausa entre
// tentativas de um `agent`, sem spawn extra); `tests/workflow-executor.test.ts`
// continua provando o comportamento fora de pausa (vazio → retry até o
// teto, null → sem retry) que este fix não pode alterar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-agent-retries.test.ts", "tests/workflow-executor.test.ts"],
} satisfies Declaracao;
