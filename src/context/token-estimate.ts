/**
 * Estimador conservador de tokens do histórico de mensagens (issue #251,
 * épico #230). Não faz chamada de rede e não usa tokenizer externo — conta
 * caracteres por tipo de bloco (texto, argumentos/; resultado de tool,
 * raciocínio) com um fator calibrado contra `usage` real de dois provedores
 * (`tests/fixtures/context/`, método em `docs/context-estimate.md`).
 */

export interface TokenEstimate {
  readonly tokens: number;
  readonly method: "heuristic";
}

export function estimateTokens(
  messages: readonly Readonly<Record<string, unknown>>[],
): TokenEstimate {
  throw new Error(`not implemented: estimateTokens (received ${String(messages?.length)} messages)`);
}
