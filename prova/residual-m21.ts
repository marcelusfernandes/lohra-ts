// Issue #594 (residual de M21, épico #561): fecha os achados non_blocking
// que sobraram das PRs #572 (#567), #573 (#568) e #591 (#569). `partialCalls`
// no `MaxIterationsError` (`errors.ts`/`runtime.ts`) e a derivação de
// `partial`/`usageUncertain` a partir dele (`child-runner.ts`), não mais de
// `stopReason === "interrupted"` sozinho — corrige o falso negativo de um
// steer absorvido numa iteração ANTERIOR à que bate o teto. Contra-caso
// pinado (`usageUncertain === false`, sem `partial`), `focusFiles` +
// mutante do `fire` idempotente de `core.ts` na fatia `supervision`, e
// `toThrow(SyntaxError)` em vez de `toThrow()` genérico.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-runtime-abort-forms.test.ts",
    "tests/orchestration-child-runner-abort.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/orchestration-steer-interrupt.test.ts",
    "tests/transports-abort-in-flight.test.ts",
    "tests/mutations-slices.test.ts",
    "tests/mutations-t23-catalog.test.ts",
  ],
} satisfies Declaracao;
