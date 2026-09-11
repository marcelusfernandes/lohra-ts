// Declaração de prova da issue #348 (chave de nodeCosts do sub-run inclui o
// nó chamador — irmãos com o mesmo ref colidiam): `runNested`'s fold
// (`src/workflow/engine.ts`, `sub[${reference}]:${nodeId}`) fica byte a byte
// dentro da âncora de mutação `nested-fold-removed`
// (`scripts/mutations/workflow-executor-mutants.ts`) — inclusive `reference`,
// que continua o `ref` bruto do template, então a mensagem de fault
// (`sub[${reference}]: ...`) não muda. O que muda é `nodeId`: cada engine
// aninhado agora grava seu PRÓPRIO `nodeCosts` já qualificado por
// `nodeScope` (`debitLeaf`, `src/workflow/engine-utils.ts`, extraído de
// `account` para caber no teto de `engine.ts` — mesma convenção de
// `scopedCheckpointId` que `resolveCheckpoint` já aplica a checkpoint ids,
// #319) ANTES de o fold rodar, então `sub1`/`sub2` reusando o mesmo `ref`
// produzem chaves distintas (`sub[inner-agent]:sub1.a` /
// `sub[inner-agent]:sub2.a`) em vez de colidir. `cacheGet` (cache hit direto)
// e `replayOrCollectBranch`/`recordGroupReplayCost` (replay de `parallel`,
// `ParallelBranchDeps.nodeScope` novo) recebem o mesmo tratamento — a raiz
// (`nodeScope` vazio) é no-op nos três caminhos. Único nó aninhado (não
// irmão): a chave declarada muda de `sub[inner]:leaf` para
// `sub[inner]:sub.leaf` (pino atualizado em `tests/workflow-nodes-tool.test.ts`
// — mudança de contrato documentada no commit e na PR). Decisão registrada em
// apêndice de `docs/decisions/2026-09-10-cache-escopo-irmaos.md`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-cells.test.ts", "tests/workflow-nodes-tool.test.ts"],
} satisfies Declaracao;
