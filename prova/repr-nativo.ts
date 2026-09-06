// Issue #72: substitui pythonRepr por citação JSON (JSON.stringify) nas
// mensagens de erro/aviso e remove src/serialization/python-repr.ts. Prova
// cobre os 4 arquivos declarados na issue (Proof) mais todo teste que fixava
// texto '…'/None/True/False produzido pelos 17 call sites do épico #16
// fase 1.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-tools.test.ts",
    "tests/mcp-config.test.ts",
    "tests/tools-stateful.test.ts",
    "tests/workflow-schema.test.ts",
    "tests/transports-public-error.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/server-service.test.ts",
    "tests/mcp-tools.test.ts",
    "tests/mcp-manager.test.ts",
    "tests/mcp-session-and-index.test.ts",
    "tests/cron-tool.test.ts",
    "tests/cron-schedule.test.ts",
    "tests/cron-validate.test.ts",
    "tests/commands-cron.test.ts",
    "tests/web-tool-chat.test.ts",
    "tests/orchestration-limits.test.ts",
    "tests/media-normalization.test.ts",
    "tests/server-usage.test.ts",
  ],
} satisfies Declaracao;
