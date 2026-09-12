// Issue #449 (M14, follow-up do épico #421, achado da PR #439 rodada 2):
// `isRouteLesson` falso e o `catch` de `appendSafe`
// (`src/workflow/route-faults.ts:93-102`, `:112-122`) não tinham oráculo —
// só o fallback "sem repositório" já tinha teste. Os três testes novos em
// `tests/workflow-route-faults.test.ts` (describe
// "recordRouteFaultNotice — the two unexercised guards (#449)") chamam
// `recordRouteFaultNotice` direto com um repositório falso: checkpoint que
// não é `RouteLesson` nunca chega ao repositório, e `append` que lança tem
// a causa (`String(error)`) no `warn`, sem propagar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-faults.test.ts"],
} satisfies Declaracao;
