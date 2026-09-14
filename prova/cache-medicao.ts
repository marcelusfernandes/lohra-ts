// Issue #624 (épico #575, follow-up do veredito r1 da PR #621/#586):
// comentários obsoletos corrigidos, asserção robusta do breakpoint de
// cache_control nos dois testes de integração, caso novo do chat COM
// tools, e medição real de `cache_read_tokens` quando houver crédito na
// conta Anthropic. Estes três arquivos são o que este `prova` prende.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/chat-prompt-caching.test.ts",
    "tests/dashboard-prompt-caching.test.ts",
    "tests/transport-anthropic-messages.test.ts",
  ],
} satisfies Declaracao;
