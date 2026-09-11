// Issue #336: `runAgent` (engine.ts:~449) e `runPipeline` (engine.ts:~544)
// creditavam um respawn em `leafRespawns` olhando só `result.pauseFault`,
// deixando escapar três caminhos onde a próxima tentativa nunca spawna:
// (a) workflow aninhado — `runNested` compartilha `control` por referência
// com o PAI, mas o filho tem `result` próprio, então um `requestPause()` no
// pai nunca aparece no `pauseFault` do filho; (b) `cancel()` nunca passa por
// `pause()`, então nunca toca `pauseFault`; (c) a expiração do deadline de
// `pipeline` (`expired`), que só chega a `collectLeaf` pelo callback
// `aborted`, nunca por `pauseFault`. O predicado único `stoppedByControl`
// (engine-utils.ts) cobre os três, reutilizado pelas duas guardas e pelo
// próprio atalho de `collectLeaf`. `tests/workflow-agent-retries.test.ts`
// cobre os três caminhos (agent aninhado + pausa externa; cancel() em
// `agent` e em `pipeline`; expiração entre tentativas de um estágio);
// `tests/workflow-parallel-retries.test.ts` prova que o `stillDying` de
// `parallel` — deliberadamente fora desta unificação (cresceria o
// `runParallel` de `engine.ts` além do teto sem mudança de comportamento
// que compense) — continua com seu comportamento pré-existente intacto.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-agent-retries.test.ts", "tests/workflow-parallel-retries.test.ts"],
} satisfies Declaracao;
