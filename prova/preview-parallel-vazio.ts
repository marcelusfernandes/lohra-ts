// Issue #503 (follow-up de #484 rodada 2, PR #497 veredito non_blocking 4):
// `classifyNode` (`src/workflow/cache-preview.ts`) caía em `outcome:
// "unknown"` para um `parallel` cujo `branches` resolve para `[]` — o dry
// run roda até o fim (`engine.ts:480`'s `runParallel`, `[].every(...)`
// vacuamente `true`, alcançando `cache.put([])` sem spawnar nenhuma folha),
// mas sem categoria própria além do catch-all. Agora sai `outcome:
// "no_leaves"`; `unknown` continua reservado para o nó nunca alcançado ou
// para um tipo que esta classificação não modela (`verify`/`checkpoint`/
// `pipeline`, provado por um `it` de não-regressão). Um mutante novo, P9
// (`scripts/mutations/supervision-mutants.ts`), reverte a string e é morto
// pelo `it` de classificação; a fatia `supervision` sobe de 31 para 32
// mutantes (258→259 no total).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-cache-preview-writes.test.ts", "tests/mutations-slices.test.ts"],
} satisfies Declaracao;
