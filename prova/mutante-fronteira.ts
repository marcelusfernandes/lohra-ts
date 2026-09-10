// Issue #283: um mutante novo (`ap`) em
// `scripts/mutations/workflow-durability-named.ts` ancora o teste de
// fronteira que #276 pinou em `tests/workflow-tiers.test.ts` (distância 2
// sugere, distância 3 não) -- antes nenhum mutante mirava
// `closestTierName`/`SUGGESTION_MAX_DISTANCE` em `src/workflow/tiers.ts`, e
// a PR #281 não podia incluir o mutante sem sair da classe overlay-only
// (a prova, só testes que passam na base, viraria `vacuous-pass`). O que
// prende o mutante em CI normal (sem rodar `npm run mutations:t16`, que é
// externo ao vitest -- ver `docs/mutation-testing.md`) é o pino de contagem:
// `tests/mutations-slices.test.ts` reprova se `workflow-durability-named.ts`
// não tiver 41 mutantes ou se a soma total não bater 173 -- a mesma linha de
// defesa que fez a issue #269 existir para os mutantes `an`/`ao`.
//
// Não existe `tests/mutations-t16-catalog.test.ts`: o pino equivalente da
// fatia `workflow-durability` é `CONTAGEM_POR_CATALOGO` dentro de
// `tests/mutations-slices.test.ts` (não um arquivo próprio, como t17/t20/t21
// têm) -- por isso um único arquivo cobre as duas AC de contagem.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts"],
} satisfies Declaracao;
