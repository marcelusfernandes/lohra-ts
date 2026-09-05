// Anexa ao job summary do GitHub Actions quando roda dentro do Actions
// (`GITHUB_STEP_SUMMARY` definido); no-op num dry-run (`prova/escopo`) ou
// numa invocação local, para o CLI continuar rodável sem environment.
import { appendFileSync } from "node:fs";

/** Anexa `markdown` a `GITHUB_STEP_SUMMARY`; no-op se a variável não está definida. */
export function appendSummary(markdown: string): void {
  const alvo = process.env["GITHUB_STEP_SUMMARY"];
  if (alvo === undefined || alvo === "") return;
  appendFileSync(alvo, `${markdown}\n`);
}
