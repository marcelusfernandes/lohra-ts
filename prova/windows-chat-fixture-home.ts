import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/chat-prompt-caching.test.ts",
    "tests/chat-audit-trail-wiring.test.ts",
    "tests/chat-provider-detectado.test.ts",
  ],
} satisfies Declaracao;
