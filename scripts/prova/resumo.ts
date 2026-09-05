// Monta o `resumo.json` a partir do que a issue declarou e do relatório
// (já normalizado) do vitest. Puro, sem I/O: quem lê o disco e roda o
// vitest é `run.ts`; aqui só há decisão.
import type { Resumo, ResultadoVitest } from "./tipos.js";

/**
 * `declarados` são os caminhos de teste (relativos à raiz) que
 * `prova/<slug>.ts` declarou em `unit`. Um declarado que não aparece em
 * `resultado.arquivos` vira uma falha `"<arquivo> did not run"` — arquivo
 * fora do `include` do vitest, ou nunca alcançado, nunca é sucesso
 * silencioso (CLAUDE.md, "falha nunca é silenciosa").
 */
export function montarResumo(declarados: readonly string[], resultado: ResultadoVitest): Resumo {
  throw new Error("not implemented");
}
