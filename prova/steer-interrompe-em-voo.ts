// Issue #520 (M16-S5, épico #490, ADR 0005): steer em folha ocupada com uma
// chamada genuinamente em voo interrompe essa chamada (D2) — nunca mais
// bloqueado por toda a duração do stream — e o parcial gasto entra na conta
// (D3: `partial`/`usageUncertain` também em turno completo). `core.ts`'s
// `entry.interrupt`/`interrupts.arm`, `conversation/runtime.ts`'s hook por
// chamada, `child-runner.ts`'s marca de `partial` no turno completo e
// `leaf.steered.data.interrupted`/`leaf.completed.data.partial`
// (audit-runtime.ts/audit-model.ts) são o que estes testes provam.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-steer-interrupt.test.ts",
    "tests/conversation-runtime-injection.test.ts",
    "tests/orchestration-core-steer.test.ts",
    "tests/workflow-audit-steered.test.ts",
  ],
} satisfies Declaracao;
