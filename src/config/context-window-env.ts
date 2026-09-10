// Override explícito da janela de contexto por variável de ambiente (issue
// #250) — o nível mais alto de precedência que `resolveContextWindow`
// (`src/providers/context-window.ts`) recebe pronto, sem I/O nem parsing
// dentro da função pura. Não segue o padrão "inválido cai no default e só
// avisa" de `positiveIntEnv` (`src/orchestration/limits.ts`): um
// `LOHRA_CONTEXT_WINDOW` inválido nunca é ignorado — é um erro nomeado, para
// nunca rodar silenciosamente com uma janela errada.

const positiveIntegerPattern = /^\d+$/;

/**
 * Lê `LOHRA_CONTEXT_WINDOW`: ausente ou em branco devolve `null` (nenhum
 * override); qualquer outra coisa precisa ser um inteiro positivo em
 * dígitos decimais (sem sinal, sem separador, sem casas decimais) ou lança
 * `LOHRA_CONTEXT_WINDOW_INVALID:<valor bruto>` — nunca cai de volta para um
 * default silenciosamente.
 */
export function resolveContextWindowOverride(
  environment: Readonly<Record<string, string | undefined>>,
): number | null {
  const raw = environment.LOHRA_CONTEXT_WINDOW;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!positiveIntegerPattern.test(trimmed)) {
    throw new Error(`LOHRA_CONTEXT_WINDOW_INVALID:${raw}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`LOHRA_CONTEXT_WINDOW_INVALID:${raw}`);
  }
  return parsed;
}
