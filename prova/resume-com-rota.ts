// Issue #427 (M10-S6, épico #421): `run_workflow(resume_run_id, route:
// {provider?, model?})` re-escreve a rota de todo nó (e stage de pipeline)
// que a declara, preservando o cache dos nós sem pino (decisão 2 do épico
// #421) e aplicando um teto de pivôs por run (decisão 4 — pivô é sempre
// manual). tests/workflow-route-override.test.ts cobre o AC de cache real
// (nós sem pino replayados, nó pinado recomputado na rota nova), a rejeição
// nomeada sem `resume_run_id`/com `route` malformado, o teto de
// `MAX_ROUTE_PIVOTS_PER_RUN`, e os exports próprios de route-override.ts.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-override.test.ts"],
} satisfies Declaracao;
