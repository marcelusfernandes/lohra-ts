// Issue #261: `readTiers` (fail-closed, #234/PR #256) chegou a `lohra tiers`
// e a `WorkflowService.start`, mas `lohra models` e a tool `list_models`
// continuavam com `loadTiers` (fail-open, `{}` em erro). Este slug prende o
// leitor fail-closed nos dois pontos restantes, a remoção de `loadTiers`
// (sem callers) e o ramo de `commands/tiers.ts` reescrito para stderr.
//
// AC 2 (chave de topo desconhecida vira aviso ou erro, com sugestão) foi
// entregue na rodada 2 da PR #268: `closestTierName` (tiers.ts) sugere o
// nome mais próximo por distância de edição, e os testes de
// `workflow-tiers.test.ts` (#261, #276) cobrem a sugestão e a fronteira.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tiers.test.ts", "tests/tools-stateful.test.ts", "tests/models.test.ts"],
} satisfies Declaracao;
