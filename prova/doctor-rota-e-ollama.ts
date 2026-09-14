// Issue #633 (non_blocking 1-3 do veredito da PR #632, issue #631):
// `chat_default_provider` agora respeita a rota (`route.error`/
// `route.mode`) em vez de chamar `detectChatProvider` incondicionalmente;
// `providerCheck` e o Check `ollama-sem-chave` usam a mesma função de
// prontidão do Ollama (`isOllamaReady`); e o bloco de exemplo em
// `docs/provedores-deteccao.md` é a saída literal de `renderChecks`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/cli-doctor.test.ts", "tests/doctor-checks-ollama.test.ts"],
} satisfies Declaracao;
