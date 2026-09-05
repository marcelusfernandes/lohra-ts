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
    if (arquivo.testes.length === 0) {
      // Coletou (não é o caso acima), mas todos os testes do arquivo são
      // skip/todo — normalizarRelatorioVitest já os excluiu de `testes`
      // (não rodaram, não passaram, não contam para `total`). Um arquivo
      // que a issue declarou e que não prova nada não pode virar
      // `ok:true` (CLAUDE.md, invariante 2). Skip PARCIAL — pelo menos um
      // teste passou/falhou — não cai aqui, porque `testes` não está vazio.
      falhas.push({
        nome: `${arquivo.arquivo} ran zero tests`,
        motivo: "todos os testes do arquivo são skip/todo — nenhum rodou de fato",
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
