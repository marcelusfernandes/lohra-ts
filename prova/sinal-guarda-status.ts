// Issue #434 (M10-S9, épico #421): follow-up do veredito da PR #433/#428.
// (1) `announceSegmentCompleted` (audit-producers.ts) só grava
// `{status: interrupted, reason: signal}` quando `status` já é
// `cancelled`/`interrupted` — um run cujo próprio `engine.run()` resolveu
// durante a janela do shutdown (a corrida `runShutdown`/`.then()`,
// service.ts:609,1218-1222) não é mais gravado como interrompido pelo
// sinal. (2) `registerShutdownTrigger` (src/cli/shutdown-trigger.ts) agora
// desarma o OUTRO sinal antes de invocar o handler — SIGTERM seguido de
// SIGINT (sem `unregister()` explícito) dispara uma única vez por
// registro.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-shutdown-signal.test.ts"],
} satisfies Declaracao;
