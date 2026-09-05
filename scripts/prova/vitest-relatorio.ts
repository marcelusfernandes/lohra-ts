// Normaliza o JSON bruto do reporter `json` do vitest (caminhos absolutos,
// forma solta) para `ResultadoVitest` (caminhos relativos à raiz, forma
// fechada) — o que `montarResumo` consome. Puro: recebe o objeto já
// parseado (`JSON.parse`) e a raiz para relativizar; não abre arquivo.
import { relative } from "node:path";

import type { ResultadoArquivo, ResultadoTeste, ResultadoVitest } from "./tipos.js";

interface AssertionResultBruto {
  readonly fullName?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly failureMessages?: unknown;
}

interface TestResultBruto {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly assertionResults?: unknown;
}

function falhaFormato(motivo: string): never {
  throw new Error(`prova: relatório do vitest em formato inesperado (${motivo})`);
}

function normalizarAssertion(bruto: unknown): ResultadoTeste {
  if (typeof bruto !== "object" || bruto === null) {
    return falhaFormato("assertionResults contém um item que não é objeto");
  }
  const assertion = bruto as AssertionResultBruto;
  const nome =
    typeof assertion.fullName === "string"
      ? assertion.fullName
      : typeof assertion.title === "string"
        ? assertion.title
        : falhaFormato("assertionResult sem fullName nem title");
  const passou = assertion.status === "passed";
  const mensagens = Array.isArray(assertion.failureMessages)
    ? assertion.failureMessages.filter((item): item is string => typeof item === "string")
    : [];
  const motivo = mensagens.length > 0 ? mensagens.join("\n") : undefined;
  return motivo === undefined ? { nome, passou } : { nome, passou, motivo };
}

function normalizarArquivo(root: string, bruto: unknown): ResultadoArquivo {
  if (typeof bruto !== "object" || bruto === null) {
    return falhaFormato("testResults contém um item que não é objeto");
  }
  const arquivo = bruto as TestResultBruto;
  if (typeof arquivo.name !== "string") {
    return falhaFormato("testResults[].name não é string");
  }
  const caminho = relative(root, arquivo.name);
  const assertionResults = arquivo.assertionResults;
  if (!Array.isArray(assertionResults)) {
    return falhaFormato("testResults[].assertionResults não é array");
  }
  if (assertionResults.length === 0 && arquivo.status === "failed") {
    const motivoColeta =
      typeof arquivo.message === "string" ? arquivo.message : "vitest não coletou este arquivo";
    return { arquivo: caminho, colecionou: false, motivoColeta, testes: [] };
  }
  const testes = assertionResults.map(normalizarAssertion);
  return { arquivo: caminho, colecionou: true, testes };
}

/**
 * `bruto` é o resultado de `JSON.parse` sobre o `--outputFile` do reporter
 * `json` do vitest — tipagem fechada aqui mesmo porque o pacote não
 * exporta um tipo público para o reporter JSON. Falha fechado (lança) em
 * vez de devolver um resultado vazio quando o formato não bate — um
 * relatório ilegível não pode virar "zero falhas" silenciosamente.
 */
export function normalizarRelatorioVitest(root: string, bruto: unknown): ResultadoVitest {
  if (typeof bruto !== "object" || bruto === null) {
    return falhaFormato("relatório não é um objeto");
  }
  const relatorio = bruto as { numTotalTests?: unknown; testResults?: unknown };
  if (typeof relatorio.numTotalTests !== "number") {
    return falhaFormato("numTotalTests não é number");
  }
  if (!Array.isArray(relatorio.testResults)) {
    return falhaFormato("testResults não é array");
  }
  const arquivos = relatorio.testResults.map((item: unknown) => normalizarArquivo(root, item));
  return { total: relatorio.numTotalTests, arquivos };
}
