// Anexa ao job summary do GitHub Actions quando roda dentro do Actions
// (`GITHUB_STEP_SUMMARY` definido); no-op num dry-run (`prova/escopo`) ou
// numa invocação local, para o CLI continuar rodável sem environment.
//
// Issue #78: compartilhado por `contratos` e `controle-negativo` (e já
// usado por `escopo`) para que os checks reajam igual a um
// `GITHUB_STEP_SUMMARY` que aponta para um caminho não gravável (diretório
// inexistente, sem permissão) — isso é uma falha de infra do runner, nunca
// do check em si: a causa vai pro stderr e a função retorna normalmente,
// nunca lança, nunca faz o check sair diferente de 0/1 por conta disso.
import { appendFileSync } from "node:fs";
import process from "node:process";

/** Anexa `markdown` a `GITHUB_STEP_SUMMARY`; no-op se a variável não está
 * definida ou vazia. Uma falha de escrita nunca propaga — vai para stderr. */
export function appendSummary(markdown: string): void {
  const alvo = process.env["GITHUB_STEP_SUMMARY"];
  if (alvo === undefined || alvo === "") return;
  try {
    appendFileSync(alvo, `${markdown}\n`);
  } catch (erro) {
    process.stderr.write(
      `ci: não foi possível escrever em GITHUB_STEP_SUMMARY (${alvo}): ${erro instanceof Error ? erro.message : String(erro)}\n`,
    );
  }
}
