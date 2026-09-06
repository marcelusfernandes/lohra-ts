// Declaração de prova da issue #153 (triagem do catálogo de closeout — 8
// mutantes de src/ migram para scripts/mutations/self-update.ts, passo 0f
// do épico #13). Lista o pino do catálogo, o pino do agregador de closeout
// aposentado (tests/t22-closeout.test.ts, que continua verde) e os arquivos
// de tests/**  que hospedam o foco de algum dos 8 mutantes.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mutations-self-update-catalog.test.ts",
    "tests/t22-closeout.test.ts",
    "tests/self-update.test.ts",
    "tests/tools-local.test.ts",
    "tests/mcp-manager.test.ts",
    "tests/gateway/session-service.test.ts",
    "tests/session-tools.test.ts",
  ],
} satisfies Declaracao;
