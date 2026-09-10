// Catálogo + runner de mutação da fatia `context-window` (issue #293) —
// STUB vermelho: o catálogo real (14 mutantes) e o runner completo chegam
// no commit seguinte. Este stub só existe para o módulo resolver (evitar
// erro de compilação/coleta do vitest ao importar um caminho inexistente) e
// falhar em RUNTIME nos pinos de `tests/mutations-slices.test.ts` (contagem
// 173→187) e `tests/mutations-t23-catalog.test.ts` (14 mutantes) — nenhum
// mutante de verdade ainda.
import { ehEntryPoint } from "./harness.js";
import type { Mutant } from "./types.js";

export const contextWindowMutants: readonly Mutant[] = [];

export function main(): never {
  throw new Error("not implemented: mutations:t23 (fatia context-window)");
}

if (ehEntryPoint(import.meta.url)) main();
