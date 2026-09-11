// Issue #403 (M8-7, épico #396): `ChildResult.forcedFallback` era
// transportado ponta a ponta mas nenhum produtor real (`child-runner.ts`)
// alguma vez preenchia `true` — o rollup `forcing_fallbacks`
// (service-rollup.ts) subestimava fallbacks de modelo decididos pela folha.
// Decisão (a): `configureFor` (client-pool.ts) já carrega um sinal real —
// `providerOverride !== null && modelOverride === null` — decidível em
// `child-runner.ts` sem tocar em nenhum outro arquivo (runtime.ts/engine.ts
// já sabiam consumir o campo corretamente).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-forced-fallback.test.ts"],
} satisfies Declaracao;
