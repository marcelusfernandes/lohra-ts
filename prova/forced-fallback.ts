// Issue #403 (M8-7, épico #396), rodada 2: `ChildResult.forcedFallback` era
// transportado ponta a ponta mas nenhum produtor real (`child-runner.ts`)
// alguma vez preenchia `true`. Decisão corrigida na rodada 2: (b) REMOVER —
// `providerOverride !== null && modelOverride === null` (rodada 1) é o caso
// NORMAL de rotear sem fixar modelo, não um fallback (`fallbackModels[0]` é
// o default do provedor, não uma segunda tentativa). `forcing_fallbacks`
// continua alimentado só pelo `usedFallback` do próprio engine (schema
// forçado sem StructuredOutput na resposta).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-forced-fallback.test.ts"],
} satisfies Declaracao;
