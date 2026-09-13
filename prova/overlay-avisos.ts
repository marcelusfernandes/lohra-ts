// Issue #589 (épico #575 P13): overlay de avisos operacionais no turno, sem
// exigir tool call. `tests/context-notices-overlay.test.ts` prova
// claim/format/build/port isolados; `tests/conversation-runtime-notices.test.ts`
// prova a fiação em `ConversationRuntime.runTurn` (AC1/AC3/AC4/AC5) sem
// tocar `tests/conversation-runtime.test.ts` (já no teto de 800 linhas,
// #584); `tests/state-notices-repository.test.ts` prova o novo escopo
// `session:<id>` (ownerless, igual a `global`) na `NoticesRepository` real.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/context-notices-overlay.test.ts",
    "tests/conversation-runtime-notices.test.ts",
    "tests/state-notices-repository.test.ts",
  ],
} satisfies Declaracao;
