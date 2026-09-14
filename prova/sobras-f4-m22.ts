// Issue #675 (sobras F4 — fecho do residual #637, M22): quatro sobras dos
// vereditos das PRs #673 e #674 — `ensureWithinRoots` fail-closed, comentário
// de `webSearchHandler`, prova de skills e âncora da WS.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/skills.test.ts",
    "tests/gateway/dashboard-ws-overlay.test.ts",
    "tests/web-tool-chat.test.ts",
  ],
} satisfies Declaracao;
