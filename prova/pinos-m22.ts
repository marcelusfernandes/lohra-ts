// Issue #648 (sub-issue A3 de #637, grupo A, itens 7-8): pinos que os
// vereditos de #579/#580/#588/#624 e a PR #610 deixaram como follow-up —
// tier `extended` chegando ao request real de chat/serve/dashboard,
// `--no-tools` mantendo memória/perfil/skills, a nota de snapshot no prompt
// do subagente, o fallback de HEAD destacado, o breakpoint de cache com
// `context` não vazio, e o oráculo de "promessa no fim" do eval.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/chat-doctrine-tier.test.ts",
    "tests/commands-serve-doctrine.test.ts",
    "tests/context-no-tools.test.ts",
    "tests/orchestration-subagent-prompt.test.ts",
    "tests/context-discovery.test.ts",
    "tests/chat-prompt-caching.test.ts",
    "tests/dashboard-prompt-caching.test.ts",
    "tests/gateway/dashboard-prompt-contract.test.ts",
    "tests/eval-cases.test.ts",
  ],
} satisfies Declaracao;
