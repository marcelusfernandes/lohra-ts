// Issue #425 (M10-S4): tool `workflow_leaf_read` (`src/workflow/leaf-read-tool.ts`,
// registered in `src/commands/session-tools.ts` alongside `workflow_notices`)
// reads the turns a still-running leaf has already committed.
// `tests/workflow-leaf-read-tool.test.ts` proves it with a real sqlite store
// (a planted `source:'orchestration'` session plus a `leaf.started` audit
// event standing in for a real spawn), no network.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-leaf-read-tool.test.ts"],
} satisfies Declaracao;
