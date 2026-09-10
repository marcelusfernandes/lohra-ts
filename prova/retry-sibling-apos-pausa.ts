// Issue #315: `collectBranchWithRetries` (engine-utils.ts) interpretava o
// `output === null` de `collectLeaf` como "branch morreu, retenta" mesmo
// quando o `null` vinha do atalho pausado/cancelado (engine.ts:235-236),
// que devolve sem spawnar, sem fault e sem cobrar assim que
// `this.control.paused` liga. Duas branches `parallel` que morrem caro:
// a que perde a corrida do orçamento chama `gateTokens()` → `pause()`
// (engine.ts:172-190), que grava `result.pauseFault` antes de qualquer
// código fora do engine observar `control.paused`; a outra, cuja
// retentativa cai depois, batia no atalho e o laço antigo confundia isso
// com morte nova — girava até o próprio teto de `retries`, inflando
// `leafRespawns` sem nenhum spawn/fault/gasto correspondente.
//
// `stillDying(leaf, deps)` para o laço assim que `deps.result.pauseFault`
// aparece, não só quando `output === null`. Residual aceito (documentado
// no próprio `stillDying`): duas branches que começam uma retentativa no
// mesmo tick ainda podem passar pela checagem antes de qualquer uma
// marcar `pauseFault` — no máximo UMA tentativa perdida por branch, nunca
// um giro completo pelo teto. `control.cancelled` sem espelho em
// `result` tem o mesmo residual e fica fora de escopo (exigiria expor
// mais estado de `control` via `ParallelBranchDeps`).
//
// `engine.ts` não muda — o fix inteiro cabe em `engine-utils.ts`, que já
// hospeda `replayOrCollectBranch` e `collectBranchWithRetries` desde a
// #242 (PR #310). O laço equivalente de `agent` (engine.ts:444) está fora
// dos `Files` desta issue e não foi tocado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-retries.test.ts"],
} satisfies Declaracao;
