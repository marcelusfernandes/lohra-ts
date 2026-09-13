// Issue #580 (épico #575, P4): bloco Harness por superfície e modo de
// execução. O que este slug prova (AC da issue): `PromptMode` existe;
// `harnessText` varia só nas linhas dependentes de modo/yolo; `harness`
// entra na faixa `stable` depois da doutrina; o subagente recebe o bloco do
// modo "subagent".
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/context-harness-mode.test.ts",
    "tests/context.test.ts",
    "tests/orchestration-subagent-prompt.test.ts",
  ],
} satisfies Declaracao;
