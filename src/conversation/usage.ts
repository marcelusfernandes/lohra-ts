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

// RED (issue #650): stub que lança — o corpo real (idêntico ao que saiu de
// `runtime.ts`/`aux.ts`) chega no commit verde seguinte, depois que
// `tests/conversation-usage.test.ts` prova o vermelho por runtime, não por
// erro de compilação (controle-negativo).
export function addUsage(_total: Usage | null, _next: Usage | null): Usage | null {
  throw new Error("not implemented: addUsage");
}
