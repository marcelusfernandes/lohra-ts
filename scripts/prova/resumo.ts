// Monta o `resumo.json` a partir do que a issue declarou e do relatório
// (já normalizado) do vitest. Puro, sem I/O: quem lê o disco e roda o
// vitest é `run.ts`; aqui só há decisão.
import type { Falha, Resumo, ResultadoVitest } from "./tipos.js";

/**
 * `declarados` são os caminhos de teste (relativos à raiz) que
 * `prova/<slug>.ts` declarou em `unit`. Um declarado que não aparece em
 * `resultado.arquivos` vira uma falha `"<arquivo> did not run"` — arquivo
 * fora do `include` do vitest, ou nunca alcançado, nunca é sucesso
 * silencioso (CLAUDE.md, "falha nunca é silenciosa").
 */
export function montarResumo(declarados: readonly string[], resultado: ResultadoVitest): Resumo {
  const falhas: Falha[] = [];
  const executados = new Set(resultado.arquivos.map((arquivo) => arquivo.arquivo));

  for (const declarado of declarados) {
    if (!executados.has(declarado)) {
      falhas.push({
        nome: `${declarado} did not run`,
        motivo: "arquivo declarado não apareceu no relatório do vitest",
      });
    }
  }

  for (const arquivo of resultado.arquivos) {
    if (!arquivo.colecionou) {
      falhas.push({
        nome: arquivo.arquivo,
        motivo: arquivo.motivoColeta ?? "vitest não conseguiu coletar este arquivo",
      });
      continue;
    }
    for (const teste of arquivo.testes) {
      if (!teste.passou) {
        falhas.push({ nome: teste.nome, motivo: teste.motivo ?? "failed" });
      }
    }
  }

  return { ok: falhas.length === 0, total: resultado.total, falhas };
}
