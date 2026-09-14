// Declaração de prova da issue #586 (épico #575, P10): prompt caching real
// nas faixas stable/context e nas tools — blocos de texto com cache_control
// na fronteira stable+context e na última tool (transporte Anthropic),
// achatamento para os consumidores que só sabem estimar uma string, sessão
// persistindo as três faixas com migração tolerante, e as caracterizações
// de chat-completions (ordem de tools) e responses (instructions
// inalterada).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/transport-anthropic-messages.test.ts",
    "tests/transport-chat-completions.test.ts",
    "tests/transport-responses.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/conversation-runtime-prompt-caching.test.ts",
    "tests/conversation-runtime-abort-forms.test.ts",
    "tests/state-session-repository.test.ts",
    "tests/context.test.ts",
  ],
} satisfies Declaracao;
