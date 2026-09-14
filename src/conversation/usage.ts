// Issue #650 (épico #637, grupo B, item 11; veredito da PR #617,
// non_blocking): módulo folha para `addUsage` — nem `runtime.ts` nem
// `aux.ts` importam um do outro para chegar aqui, então os dois (e
// `envelope.ts`, que já importava a função de `runtime.ts`) importam desta
// SEM ciclo. Antes desta issue, `aux.ts:52-66` carregava uma cópia idêntica
// com um comentário explicando por que não podia importar de `runtime.ts`
// (`runtime.ts` importa `summarizeWithFallback` de `aux.ts` — o sentido
// contrário ciclaria). Precedente de módulo folha: `summary-budget.ts`
// (issue #620).
import type { Usage } from "../transports/index.js";

export function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total;
  if (total === null) return { ...next };
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}
