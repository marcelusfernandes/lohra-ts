// Normaliza o JSON bruto do reporter `json` do vitest (caminhos absolutos,
// forma solta) para `ResultadoVitest` (caminhos relativos à raiz, forma
// fechada) — o que `montarResumo` consome. Puro: recebe o objeto já
// parseado (`JSON.parse`) e a raiz para relativizar; não abre arquivo.
import { relative } from "node:path";

import type { ResultadoVitest } from "./tipos.js";

/**
 * `bruto` é o resultado de `JSON.parse` sobre o `--outputFile` do reporter
 * `json` do vitest — tipagem fechada aqui mesmo porque o pacote não
 * exporta um tipo público para o reporter JSON.
 */
export function normalizarRelatorioVitest(root: string, bruto: unknown): ResultadoVitest {
  throw new Error("not implemented");
}
