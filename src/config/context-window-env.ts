// Override explícito da janela de contexto por variável de ambiente (issue
// #250) — o nível mais alto de precedência que `resolveContextWindow`
// (`src/providers/context-window.ts`) recebe pronto, sem I/O nem parsing
// dentro da função pura. Não segue o padrão "inválido cai no default e só
// avisa" de `positiveIntEnv` (`src/orchestration/limits.ts`): um
// `LOHRA_CONTEXT_WINDOW` inválido nunca é ignorado — é um erro nomeado, para
// nunca rodar silenciosamente com uma janela errada.

export function resolveContextWindowOverride(
  _environment: Readonly<Record<string, string | undefined>>,
): number | null {
  throw new Error("not implemented: resolveContextWindowOverride");
}
