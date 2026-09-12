// Issue #419 (M8-12, épico #396): decisão do owner sob ADR 0003 — remove a
// chave `forced_fallback` do envelope de `collect_session` (sempre `false`,
// sem produtor desde #417) e `CollectResult.forcedFallback`. Pino de chaves
// de `collect_session` 13 -> 12; `delegate_task` não tinha `forced_fallback`
// entre suas 8 chaves (#429), então fica inalterado.
//
// `tests/orchestration-tools.test.ts` repina o envelope de `collect_session`
// sem `forced_fallback` (assertion-red na base, que ainda escreve a chave).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/orchestration-tools.test.ts"],
} satisfies Declaracao;
