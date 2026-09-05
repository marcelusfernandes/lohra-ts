// Anexa ao job summary do GitHub Actions quando roda dentro do Actions
// (`GITHUB_STEP_SUMMARY` definido); no-op num dry-run (`prova/escopo`) ou
// numa invocação local, para o CLI continuar rodável sem environment.
//
// STUB (test(red), issue #49): implementação real vem no commit seguinte.

/** Anexa `markdown` a `GITHUB_STEP_SUMMARY`; no-op se a variável não está definida. */
export function appendSummary(_markdown: string): void {
  throw new Error("not implemented");
}
