// Issue #576: escrita incremental de `results.jsonl` (uma linha por caso,
// anexada ao terminar cada caso — um crash no meio da corrida não perde o
// que já rodou) e o `summary.json` final.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalResultLine, EvalSummary, EvalSummaryCase, EvalMode } from "./types.js";

export function appendResultLine(path: string, line: EvalResultLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** Trunca `results.jsonl` antes de uma corrida nova — sem isso, uma corrida
 * anterior do MESMO diretório de saída deixaria linhas de casos que essa
 * corrida nem tentou, misturadas com as novas (mesmo padrão de
 * `scripts/prova/run.ts`: relatório velho nunca sobrevive a uma execução
 * nova do mesmo alvo). */
export function resetResultsFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

function totalTokens(line: EvalResultLine): number | null {
  if (line.usageTotal === null) return null;
  return line.usageTotal.inputTokens + line.usageTotal.outputTokens;
}

export function buildSummary(
  mode: EvalMode,
  provider: string | undefined,
  lines: readonly EvalResultLine[],
): EvalSummary {
  const cases: EvalSummaryCase[] = lines.map((line) => ({
    id: line.id,
    mechanismOk: line.mechanismOk,
    outcomeVerdict: line.outcome?.verdict ?? "n/a",
    totalTokens: totalTokens(line),
    budgetExceeded: line.budgetExceeded,
  }));
  return {
    generatedAt: new Date().toISOString(),
    mode,
    ...(provider === undefined ? {} : { provider }),
    total: lines.length,
    // `=== true`, nunca truthy solto: `"skipped"` também é truthy em JS e
    // não pode contar como aprovado (era exatamente essa confusão, com
    // `mechanismOk: true` fixo, que a rodada 2 corrigiu).
    mechanismPassCount: lines.filter((line) => line.mechanismOk === true).length,
    mechanismSkippedCount: lines.filter((line) => line.mechanismOk === "skipped").length,
    outcomePassCount: lines.filter((line) => line.outcome?.verdict === "pass").length,
    cases,
  };
}

export function writeSummary(path: string, summary: EvalSummary): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
}
