// Issue #245: `render` (`src/commands/workflow.ts`) agora acrescenta o
// `pause_reason` ao status de um run pausado e o `+N over` quando o gasto
// excede `token_budget`; `watch` escreve a dica de retomada correspondente
// (reusada de `src/workflow/service.ts`) no stderr ao terminar em `paused`
// — `quota_exhausted` não tem dica, por auto-retomar sozinho.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-command.test.ts"],
} satisfies Declaracao;
