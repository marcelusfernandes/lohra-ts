// Issue #670 (residual F3 — sub-issue final de #637, grupo F): notices,
// rowNumber, untrusted em web_fetch, realpath. Quatro correções cirúrgicas
// dos vereditos das PRs #655, #656, #658 e #667, mais cinco comentários de
// carona e a limpeza de `tests/eval-cases.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tools-notices-description.test.ts",
    "tests/state-notices-repository.test.ts",
    "tests/web-tool-chat.test.ts",
    "tests/web-fetch.test.ts",
    "tests/session-tools.test.ts",
    "tests/tools-local.test.ts",
    "tests/tools-stateful.test.ts",
    "tests/eval-cases.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
