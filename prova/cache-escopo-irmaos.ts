// Declaração de prova da issue #332 (célula de cache e nodeCosts de irmãos
// aninhados idênticos): `WorkflowEngine.specIdentity` (src/workflow/engine.ts)
// agora dobra `nodeScope` — antes só `[spec.name, spec.meta.version ?? null]`,
// igual para toda célula do MESMO template não importa sob qual nó
// `workflow` foi carregado. Dois nós irmãos `{ type: "workflow", ref:
// "inner" }` com entradas idênticas produziam a mesma célula de cache para
// `agent`/`parallel` (grupo e por-branch, via `ParallelBranchDeps.spec`) —
// o segundo herdava a saída (e o custo zero) do primeiro. `runCheckpoint`
// (engine.ts, já corrigido em #319) simplifica: o `nodeScope` que
// prependia manualmente agora vem de `specIdentity`, hash byte-idêntico.
// `tests/workflow-parallel-cells.test.ts` ganha os dois describes novos:
// `nested siblings reusing an identical template — cell scope (#332)`
// (agent e parallel, dois spawns/quatro spawns reais, saída própria por
// irmão) e `root cell identity is unchanged by the #332 scope fix — compat`
// (hash de raiz calculado pela mesma fórmula da base, HIT sem spawn — prova
// de que nodeScope vazio é no-op). Decisão registrada em
// `docs/decisions/2026-09-10-cache-escopo-irmaos.md`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-cells.test.ts", "tests/workflow-checkpoint-aninhado.test.ts"],
} satisfies Declaracao;
