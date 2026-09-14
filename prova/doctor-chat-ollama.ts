// Issue #631: `doctor.usable` já contava Ollama vivo, mas `chat`/`dashboard`
// sem `--provider` (issue #604, `detectChatProvider`) ignoram Ollama --
// `chat_default_provider` e o Check `ollama-sem-chave` fecham essa lacuna
// sem mudar `chat.ts`/`chat-boundary.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/cli-doctor.test.ts", "tests/chat-provider-detectado.test.ts"],
} satisfies Declaracao;
