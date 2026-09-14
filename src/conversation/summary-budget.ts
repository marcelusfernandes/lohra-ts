// Issue #620 (follow-up do veredito da PR #617, épico #575): `summaryMaxTokens`
// (issue #584) vivia inteira em `compaction.ts`, que já importa `SUMMARY_SYSTEM`
// de `../agent/aux.js` -- `aux.ts` importar `summaryMaxTokens` de volta de
// `compaction.ts` cicla. Módulo folha: não importa `compaction.ts` nem
// `aux.ts`, só é reexportado por `compaction.ts` para os chamadores/testes
// que já a referenciavam de lá, e importado direto por `AuxClient` (`aux.ts`)
// para que `AuxTelemetry.summarize` use o MESMO orçamento que
// `buildSummaryRequest` (o summarizer default de `ConversationRuntime`) já
// usava desde a #584 -- antes desta issue, um perfil com `defaultAuxModel`
// resumia com `maxTokens` fixo em 1024 qualquer que fosse o tamanho do fold,
// truncando exatamente as duas seções verbatim que a #584 existe para
// preservar.

/** Piso (nunca menor que o `maxTokens` fixo de antes da #584 -- uma sessão
 * curta não fica pior), teto (o resumo é um meio de encolher o turno, não um
 * segundo transcript) e divisor da proporção `foldedTokens / divisor`. */
export const SUMMARY_MAX_TOKENS_FLOOR = 1024;
export const SUMMARY_MAX_TOKENS_CEILING = 4096;
export const SUMMARY_MAX_TOKENS_DIVISOR = 8;

/**
 * `clamp(1024, ceil(foldedTokens / 8), 4096)` (issue #584 AC). Pure.
 */
export function summaryMaxTokens(foldedTokens: number): number {
  const proportional = Math.ceil(Math.max(0, foldedTokens) / SUMMARY_MAX_TOKENS_DIVISOR);
  return Math.min(SUMMARY_MAX_TOKENS_CEILING, Math.max(SUMMARY_MAX_TOKENS_FLOOR, proportional));
}
