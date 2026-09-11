// Issue #422 (M10-S1): o steer de uma folha descartava o 3º argumento
// (causalContext) — `OrchestrationChildRuntime.steer` (orchestration-runtime
// .ts) nunca implementava `causalSnapshot`, e `OrchestrationCore.steer`
// (core.ts) enfileirava na inbox sem teto. `tests/orchestration-steer-identity
// .test.ts` prova: causalSnapshot devolve/limpa a identidade da folha viva,
// steer repassa `causal` ao core, e o 11º steer na mesma folha ocupada é
// recusado (`refused: "steer_cap"`) sem derrubar os 10 anteriores.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/orchestration-steer-identity.test.ts"],
} satisfies Declaracao;
