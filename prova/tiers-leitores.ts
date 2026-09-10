// Issue #261: `readTiers` (fail-closed, #234/PR #256) chegou a `lohra tiers`
// e a `WorkflowService.start`, mas `lohra models` e a tool `list_models`
// continuavam com `loadTiers` (fail-open, `{}` em erro). Este slug prende o
// leitor fail-closed nos dois pontos restantes, a remoção de `loadTiers`
// (sem callers) e o ramo de `commands/tiers.ts` reescrito para stderr.
//
// AC 2 (chave de topo desconhecida vira aviso ou erro, com sugestão) ficou
// bloqueado — ver comentário na issue: a decisão "recusar" quebra uma
// asserção de `tests/providers.test.ts`, fora dos `Files` desta issue.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tiers.test.ts", "tests/tools-stateful.test.ts", "tests/models.test.ts"],
} satisfies Declaracao;
