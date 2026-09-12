// Issue #517 (M16-S2, épico #490, ADR 0005): `ChildResult.partial?` carrega
// um sinal de "usage estimada, chamada abortada em voo" através de
// `RunResult.partialLeaves` (accounting.ts, via `recordLeafSideChannels`,
// nunca tocando engine-utils.ts), da allow-list booleana do ledger
// (`audit-model.ts:91`) e do construtor único de payload `failedPayload`
// (audit-runtime.ts) que `collect()` e `cancel()` agora compartilham.
// `tests/workflow-partial-leaves.test.ts` é o teste novo desta issue;
// `tests/workflow-audit-allow-list.test.ts` ganha os dois oráculos da
// allow-list; `tests/workflow-audit-leaf.test.ts` continua cobrindo os
// pinos de forma (`error_kind: "cancelled"`/`reason: "cancelled"`) que este
// fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-partial-leaves.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
    "tests/workflow-audit-leaf.test.ts",
  ],
} satisfies Declaracao;
