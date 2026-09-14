// Issue #641 (épico #637, grupo F, item 21): exports mortos de
// `filesystem.ts`/`terminal.ts`, o ramo `"none"` e as duas frases falsas da
// linha de tools do subagente, `REMINDER_LINE` e os docblocks desatualizados
// de `harness.ts`, e o teste do dashboard com espera fixa e sem semear
// identidade.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tools-filesystem-description.test.ts",
    "tests/tools-terminal-description.test.ts",
    "tests/orchestration-subagent-prompt.test.ts",
    "tests/context-harness-mode.test.ts",
    "tests/gateway/dashboard-prompt-contract.test.ts",
  ],
} satisfies Declaracao;
