// Issue #569 (M16 pós-revisão, épico #561, S5): precedência cancel × steer-
// interrupt discriminante (`ConversationRuntime.runTurn`, o conjunto
// `&& !signalAborted(signal)` de `runtime.ts:553`), disarm-on-fire para um
// segundo `steer()` sobre o mesmo hook ainda não desarmado
// (`OrchestrationCore.runAndTrack`'s `interrupts.arm`), `MaxIterationsError`
// carregando `usage`/`stopReason: "interrupted"` — e, rodada 2 (veredito da
// PR #591), `partial`/`usageUncertain` forçados no `CollectResult`
// (`child-runner.ts`) quando esse erro vem de um turno com chamada(s)
// interrompida(s) — depois de uma última iteração absorvida por steer, e o
// evento `model.request.interrupted` carregando o nome do erro torn-down
// como `code` (nunca mais descartado em silêncio).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-runtime.test.ts",
    "tests/conversation-runtime-injection.test.ts",
    "tests/orchestration-steer-interrupt.test.ts",
    "tests/orchestration-child-runner-abort.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/mutations-t23-catalog.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
