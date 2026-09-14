// Issue #649 (sub-issue B1 de #637): sessão retomada usa as faixas
// persistidas do system prompt, byte-idênticas, em vez de recomputar via
// promptSnapshot() -- invariante 1 (CLAUDE.md) valia só dentro de um
// processo antes desta issue. `resolveTurnSession`
// (src/conversation/runtime-session.ts) absorve o ramo inteiro que
// resolvia a sessão do turno, extraído de runtime.ts (796/800 linhas).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-runtime-prompt-caching.test.ts",
    "tests/conversation-runtime-session.test.ts",
    "tests/conversation-sqlite-prompt-caching.test.ts",
    "tests/chat-prompt-caching.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
