// Declaração de prova da issue #152 (mutations:t20 sem oráculo Python,
// passo 0e do épico #13). Lista os arquivos de tests/web-*.test.ts que
// hospedam o foco de algum dos 9 mutantes de
// scripts/mutations/web-tools-mutants.ts, mais o pino do catálogo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/web-connector.test.ts",
    "tests/web-fetch.test.ts",
    "tests/web-safety.test.ts",
    "tests/web-search.test.ts",
    "tests/web-tool-chat.test.ts",
    "tests/mutations-t20-catalog.test.ts",
  ],
} satisfies Declaracao;
