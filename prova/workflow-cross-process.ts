// Issue #103: prova cross-process de que um workflow durável sobrevive ao
// processo que o lançou. Processo A (worker em `tests/workers/`, spawnado
// via `tsx`, nunca `dist/`) lança um run durável, cacheia a célula do
// primeiro nó e é morto com SIGKILL enquanto o segundo leaf está em voo; o
// processo de teste então lê o mesmo `state.db` via `runWorkflowCommand`
// (`list`/`watch`/`audit`, com `now` injetado para provar staleness sem
// depender do relógio real) e um processo C retoma via `resume_run_id`,
// provando por contagem de spawns — nunca por tempo — que a célula cacheada
// não é reexecutada.
//
// (commit test(red): os workers de `tests/workers/` ainda não existem;
// `tests/workflow-command.test.ts` chega num commit seguinte, que também
// atualiza `unit` abaixo.)
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-cross-process.test.ts"],
} satisfies Declaracao;
