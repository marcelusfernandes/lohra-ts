// Catálogo irmão de `supervision-mutants.ts` (issue #647, grupo A de #637,
// item 6): o primeiro estava em EXATAMENTE 800 linhas (PR #609/#627 já
// tinham desviado mutante para `workflow-audit-producers-mutants.ts` e
// `context-window.ts` por causa disso) e o próximo achado da fatia
// `supervision` não tinha onde morar sem apagar prosa. Recebe, movido sem
// alteração de `before`/`after`/`focus`, os 8 mutantes N1-N4/V1/W1/X1/Y1 do
// bloco final do catálogo original (abort em voo #519, `normalizeResumeId`
// #540, fold de faults #540 r2, achados 2/3 de #594).
//
// Arquivo separado de `supervision-mutants.ts` (não um `Files` que
// autorizasse crescer aquele arquivo além do teto de 800 linhas) — o
// runner de `supervision.ts` concatena os dois catálogos em `main()`. Dado
// puro (`export const supervisionMutants2`), sem `main()` de topo: seguro
// para `import` estático em `tests/mutations-slices.test.ts`, mesmo padrão
// de `context-prompt-mutants.ts` (issue #646).
//
// Stub vermelho (worktree-segura §7 / controle-negativo `structural-red`,
// `scripts/ci/controle-negativo/run.ts:538-552`): o catálogo de verdade
// ainda não existe — `pendente()` lança para que qualquer importador
// estático (`tests/mutations-slices.test.ts`) falhe por erro de
// carregamento de módulo, não por uma asserção. O commit verde seguinte
// substitui o array pelos 8 mutantes reais.
import type { Mutant } from "./types.js";

function pendente(): never {
  throw new Error("catálogo pendente (issue #647): supervisionMutants2 ainda não implementado");
}

export const supervisionMutants2: readonly Mutant[] = pendente();
