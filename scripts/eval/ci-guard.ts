// Issue #576 (rodada 2): guarda "nunca --provider em CI", extraída para
// módulo próprio para valer tanto no CLI (`run.ts`, `main()`) quanto em
// qualquer chamador direto de `runEvalCase` (`session.ts`) — a garantia
// não pode depender de só o caminho `npm run eval` existir.
//
// Aceita qualquer valor "truthy" de `CI`/`GITHUB_ACTIONS`: GitHub Actions
// usa `"true"`, mas outros provedores de CI usam `"1"` — travar só na
// string exata `"true"` deixaria essa segunda forma passar despercebida.
// `""`, `"0"` e `"false"` (qualquer capitalização) contam como ausente.
function isTruthyCiFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** AC "o eval nunca faz rede sem --provider; com --provider, nunca roda no
 * CI" — a segunda metade é este fault; a primeira é estrutural em
 * `session.ts` (o ambiente da chamada em modo stub nunca inclui o
 * `process.env` real). */
export function refuseNetworkInCi(
  provider: string | undefined,
  environment: NodeJS.ProcessEnv,
): void {
  if (provider === undefined) return;
  if (isTruthyCiFlag(environment.CI) || isTruthyCiFlag(environment.GITHUB_ACTIONS)) {
    throw new Error(
      "eval: --provider nunca roda em CI (CI ou GITHUB_ACTIONS truthy) — rode localmente para gravar um baseline real",
    );
  }
}
