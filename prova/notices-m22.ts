// Issue #652 (sub-issue C2 de #637): `list()` sem escopo excluindo
// `session:*` por default (`includeSessions`), `acked_at` ilegível virando
// `null` com `warning` nomeado em vez de `NaN` silencioso, `\u200B` legível
// em `notices-overlay.ts`, `timeout` reservado (nota de decisão) e o pino
// de conteúdo de `UNTRUSTED_CONTENT_NOTICE`. `tests/mutations-slices.test.ts`
// prova a contagem de mutantes (320) e a fatia `context-window` (29 em
// `context-window.ts`, os dois novos em `notices-repository.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/state-notices-repository.test.ts",
    "tests/workflow-notices-tool.test.ts",
    "tests/context-notices-overlay.test.ts",
    "tests/tools-untrusted-content-notice.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
