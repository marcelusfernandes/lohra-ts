// Issue #276: três achados de força de teste deixados fora dos `Files` das
// PRs #268 e #273. (1) `closestTierName` (tiers.ts:69-77) usa
// `best.distance <= SUGGESTION_MAX_DISTANCE`; os testes cobriam distância 1
// (`smal`) e 3 (`foo`), nunca a fronteira em 2 — mutantes `<=`→`<` e `2`→`1`
// sobreviviam. (2) `tests/tools-stateful.test.ts` injetava, no caso de mapa
// de tiers quebrado, um builder que resolve normalmente — não provava que
// `list_models` recusa antes de tocar a rede (ordem erro-antes-da-rede).
// (3) o comentário de `prova/tiers-leitores.ts` dizia o AC 2 bloqueado,
// desatualizado desde a rodada 2 de #268.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tiers.test.ts", "tests/tools-stateful.test.ts"],
} satisfies Declaracao;
