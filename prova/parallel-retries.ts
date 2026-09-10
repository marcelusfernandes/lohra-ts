// Issue #242: `parallel.retries` (int, 0-3, default 0) — opt-in, só para
// branch MORTA (`output === null`), nunca para saída vazia (dado legítimo
// sem schema), com teto (reusa `MAX_NODE_RETRIES`, o mesmo de `agent`).
//
// `engine.ts` já estava no teto do contrato `arquivo-grande` (996 linhas,
// igual à base) — orçamento de crescimento zero. A emenda de `## Files`
// (comentário do orquestrador em 2026-09-10) moveu o laço de retry para
// `src/workflow/engine-utils.ts`, ao lado de `replayOrCollectBranch` e
// `recordGroupReplayCost` (já lá desde a #241, mesma razão: lógica por
// branch não pertence a `engine.ts`). `collectBranchWithRetries` chama
// `replayOrCollectBranch` em laço enquanto `output === null`, incrementando
// `leafRespawns` por retentativa; `engine.ts` só troca o nome da função no
// `.map(...)` de `runParallel` e na importação — 996 linhas antes e depois,
// âncoras do catálogo de mutação (`fanout-check-after-spawn`) intocadas.
//
// O teto de orçamento por retentativa não precisou de código novo:
// `collectLeaf` (chamado por `replayOrCollectBranch`) já roda
// `gateTokens`/`gateFanout(1, true)` a cada leaf que coleta, retry
// incluído. O rastro de falha também é o existente: `collectLeaf` já grava
// um fault com causa em toda morte de leaf (timeout, cancelamento, erro do
// runtime) antes de devolver `output: null` — esgotar o teto não precisou
// de um fault novo, só do `null` posicional que já é o comportamento
// atual.
//
// `nodes.ts` ganhou `retries` na lista de campos de `parallel` — sem isso
// `validateShape` rejeita o campo como `unknown_field`. A faixa (0-3) já
// era validada genericamente por `validateLifecycle` (`schema.ts`) para
// QUALQUER node com o campo, então nenhuma mudança de schema.ts foi
// necessária além do teste que pina o comportamento.
//
// tests/workflow-parallel-retries.test.ts é novo (#241 já tinha batido
// nesse mesmo teto de `tests/workflow-executor.test.ts`, 762/800 linhas —
// mesma solução: arquivo próprio). tests/workflow-schema.test.ts pina a
// faixa 0-3 em um node parallel. tests/workflow-executor.test.ts continua
// listado como regressão do resto do comportamento de `parallel` (cache
// por branch, ordem declarada) que o retry não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-parallel-retries.test.ts",
    "tests/workflow-schema.test.ts",
    "tests/workflow-executor.test.ts",
  ],
} satisfies Declaracao;
