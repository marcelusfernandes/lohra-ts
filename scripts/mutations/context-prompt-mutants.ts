// Catálogo de dado puro da fatia `context-window` (issue #646, sub-issue A1
// de #637): mutantes de doutrina (`src/context/doctrine.ts`), moldura de
// memória/perfil/instruções e nota de snapshot (`src/context/
// system-prompt.ts`), snapshot de git (`src/context/discovery.ts`) e as
// seções verbatim/truncamento de cauda do resumo (`src/agent/aux.ts`,
// `src/conversation/compaction.ts`) — nenhum desses arquivos tinha mutante
// em nenhuma fatia até aqui (achado de #637: cinco issues de prompt em M22
// mergeadas sem mutante nenhum sobre o código novo).
//
// Arquivo separado de `context-window.ts` (não um `Files` que autorizasse
// crescer aquele arquivo além do teto de 800 linhas) — o runner de
// `context-window.ts` concatena os dois catálogos em `main()`. Dado puro
// (`export const contextPromptMutants`), sem `main()` de topo: seguro para
// `import` estático em `tests/mutations-slices.test.ts` e
// `tests/mutations-t23-catalog.test.ts`, mesmo padrão de
// `scripts/mutations/supervision-mutants.ts`.
//
// Stub vermelho (worktree-segura §7 / controle-negativo `structural-red`,
// `scripts/ci/controle-negativo/run.ts:538-552`): o catálogo de verdade
// ainda não existe — `pendente()` lança para que qualquer importador
// estático (`tests/mutations-slices.test.ts`, `tests/mutations-t23-
// catalog.test.ts`) falhe por erro de carregamento de módulo, não por uma
// asserção. O commit verde seguinte substitui o array pelos 16 mutantes
// reais.
import type { Mutant } from "./types.js";

function pendente(): never {
  throw new Error("catálogo pendente (issue #646): contextPromptMutants ainda não implementado");
}

export const contextPromptMutants: readonly Mutant[] = pendente();
