// Issue #73: mensagens de erro e help da CLI passam a ser texto próprio
// (usage: + lohra: error:, exit 2 preservado) em vez de emulação do
// argparse (ADR 0003, "Human-facing text"). A prova cobre os quatro casos
// de erro no molde novo, o --help de topo/chat/tiers, os exit codes de
// cron.ts e o comentário de orchestration/limits.ts.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/cli-arg-validation.test.ts",
    "tests/cli-chat-arguments.test.ts",
    "tests/cli-doctor.test.ts",
    "tests/commands-cron.test.ts",
    "tests/orchestration-limits.test.ts",
  ],
} satisfies Declaracao;
