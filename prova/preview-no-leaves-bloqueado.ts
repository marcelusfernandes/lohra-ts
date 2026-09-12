// Issue #515 (follow-up de #503, veredito da PR #510, non_blocking 2 e 3):
// `classifyNode` (`src/workflow/cache-preview.ts`) chegava a `no_leaves`
// checando `spawns === 0 && hits === 0` — tautológico nesse ponto da
// função, os dois returns anteriores já garantem isso — misturando
// `branches: []` (nada a pagar de verdade) com dois casos genuinamente
// bloqueados que também chegam ali com `output === null`, não `[]`:
// `branches` que nunca resolveu para array (um template como
// `${bad.value}` sobre um upstream que falhou) e um `parallel` acima do
// cap de fan-out (`FanoutRejected`). O guard agora exige
// `Array.isArray(output) && output.length === 0`; o primeiro caso passa a
// reportar `upstream_missing` (o MESMO outcome que `agent` já recebe para
// um `${...}` não resolvido, via `hasNodeFault` — sem crescer `engine.ts`,
// congelado em 978 linhas), e o segundo cai no `unknown` do catch-all
// (`capTrips` é uma contagem do run inteiro, não atribuível a este nó sem
// crescer `engine.ts`). P10 (`scripts/mutations/supervision-mutants.ts`)
// mata a remoção do novo guard `Array.isArray`; a fatia `supervision` sobe
// de 32 para 33 mutantes (259→260 no total).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-cache-preview-writes.test.ts", "tests/mutations-slices.test.ts"],
} satisfies Declaracao;
