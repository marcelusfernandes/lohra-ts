// Issue #269: dois mutantes novos (`an`/`ao`) em
// `scripts/mutations/workflow-durability-named.ts` ancoram a correção de
// #258 (mapa de tiers do operador não chegava ao `WorkflowEngine`) nos dois
// pontos de construção -- `engineBaseOptions` (engine-options.ts) e o call
// site de `launchDurable` (service.ts). O que prende os mutantes em CI
// normal (sem rodar `npm run mutations:t16`, que é externo ao vitest -- ver
// `docs/mutation-testing.md`) é o pino de contagem: `tests/mutations-slices.test.ts`
// reprova se `workflow-durability-named.ts` não tiver 41 mutantes, se a soma
// total não bater 173, ou se `focusFiles` da fatia `workflow-durability` não
// incluir `tests/workflow-tiers.test.ts` -- as três a mesma linha de defesa
// que fez esta issue existir (nenhum catálogo mirava essa fiação antes).
//
// Não existe `tests/mutations-t16-catalog.test.ts`: o pino equivalente da
// fatia `workflow-durability` é `CONTAGEM_POR_CATALOGO` dentro de
// `tests/mutations-slices.test.ts` (não um arquivo próprio, como t17/t20/t21
// têm) -- por isso um único arquivo cobre as duas AC de contagem.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts"],
} satisfies Declaracao;
