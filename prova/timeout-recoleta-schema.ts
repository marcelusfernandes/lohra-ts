// Issue #329: `collectLeaf`'s SEGUNDO `collect()` — a re-coleta pós-steer do
// laço de validação de schema (engine.ts) — também pode devolver
// `status: "running"` (timeout), mas caía no ramo genérico de não-completo:
// `account()` sem `runtime.cancel(id)` nem fault nomeado, diferente do
// PRIMEIRO `collect()` (#313). A folha ficava órfã no runtime e o usage
// nunca era marcado `usageUncertain`. `recollectLeafTimeout`
// (engine-utils.ts) dá ao segundo ponto o mesmo tratamento do primeiro
// (cancel + fault com causa + `timeoutLeafResult`) sem tocar a âncora
// inline do primeiro (mutante `timeout-no-cooperative-cancel`). O teste em
// "timeout during the schema re-collect loop (#329)" de
// workflow-parallel-retries.test.ts scripta o mesmo leaf id com uma saída
// que falha o schema (força a re-coleta) seguida de `status: "running"` e
// prende: `runtime.cancel(id)` chamado, fault com "timeout", e
// `usageUncertainLeaves` = 1.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-retries.test.ts"],
} satisfies Declaracao;
