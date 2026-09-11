// Issue #336: `runAgent` (engine.ts:~449), `runPipeline` (engine.ts:~544) e
// `stillDying` (engine-utils.ts, retries de `parallel`) creditavam um
// respawn em `leafRespawns` olhando só `result.pauseFault`, deixando
// escapar caminhos onde a próxima tentativa nunca spawna: (a) workflow
// aninhado — `runNested` compartilha `control` por referência com o PAI,
// mas o filho tem `result` próprio, então um `requestPause()` no pai nunca
// aparece no `pauseFault` do filho; (b) `cancel()` nunca passa por
// `pause()`, então nunca toca `pauseFault`; (c) a expiração do deadline de
// `pipeline` (`expired`), que só chega a `collectLeaf` pelo callback
// `aborted`, nunca por `pauseFault`. O predicado único `stoppedByControl`
// (engine-utils.ts) cobre os três, reutilizado pelas três guardas (as duas
// de `engine.ts` e a de `stillDying`) e pelo próprio atalho de
// `collectLeaf`. `tests/workflow-agent-retries.test.ts` cobre os três
// caminhos em `agent`/`pipeline` (agent aninhado + pausa externa; cancel()
// em `agent` e em `pipeline`; expiração entre tentativas de um estágio);
// `tests/workflow-parallel-retries.test.ts` cobre o mesmo `cancel()` para
// `stillDying` — comportamento NOVO desde a unificação, não mais o
// pré-existente.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-agent-retries.test.ts", "tests/workflow-parallel-retries.test.ts"],
} satisfies Declaracao;
