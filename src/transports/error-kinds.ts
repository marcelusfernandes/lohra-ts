/** Vocabulário fechado de tipos de falha de provedor (M8-1, issue #397).
 * `classifyProviderError` (`errors.ts`) produz um destes ou `null`; folha,
 * run, rollup e auditoria falam este tipo em vez de `string | null`.
 * `sandbox_denied` e não `sandbox_refused`: decisão do épico #396.
 * `timeout`/`cancelled` reservados para reuso pela folha; `context_length`
 * reservado para o classificador de janela; `unknown` nomeia um
 * `ProviderCallFailed` sem mapeamento — nunca silêncio (invariante 2). */
export const ERROR_KINDS = [
  "quota_exhausted",
  "auth_failed",
  "model_not_found",
  "route_fault",
  "sandbox_denied",
  "timeout",
  "cancelled",
  "context_length",
  "unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export const ERROR_KIND_SET: ReadonlySet<string> = new Set(ERROR_KINDS);

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && ERROR_KIND_SET.has(value);
}
