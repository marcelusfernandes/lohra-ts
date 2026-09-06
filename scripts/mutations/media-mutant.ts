// Tipo do catálogo declarativo de `scripts/mutations/media.ts` (issue
// #151, passo 0d do épico #13): 20 mutantes de mídia com `id`, `category`
// e `edits` explícitos, mecânica B (cópia de `src/`, import em processo,
// comparador) preservada do runner de mídia que este arquivo substitui.
//
// Diferente do `Mutant` de `types.ts` (mecânica A: foco de vitest rodado
// em subprocesso contra um sandbox de `git archive`), aqui não existe um
// teste focal — o oráculo é o `expected` do próprio mutante, e `probe`
// roda dentro do processo contra o módulo (mutado ou restaurado, já
// carregado por quem chama). `probe` precisa devolver, nos dois caminhos,
// um `actual` com exatamente as chaves de `expected` — é isso que deixa
// `restoreGreen` (comparador contra a árvore restaurada) auditável em vez
// de sempre falso ou sempre verdadeiro por construção.
import type { Edit } from "./types.js";

export interface MediaMutant {
  readonly id: string;
  readonly category: string;
  /** Caminho do módulo sob teste, relativo à raiz de `src/`. */
  readonly entry: string;
  readonly edits: readonly Edit[];
  /** O oráculo: o shape que `probe` deve produzir quando o guard real
   * segue de pé (mutado ou não). */
  readonly expected: unknown;
  readonly probe: (module: Record<string, unknown>) => Promise<unknown>;
}
