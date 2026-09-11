// Issue #402 (M8-6): tools `workflow_notices`/`workflow_notices_ack`
// (`src/workflow/notices-tool.ts`, registered in `src/commands/session-tools.ts`
// alongside `workflowAuditHandler`) and the CLI `lohra workflow notices`
// (`src/cli/arg-spec.ts`, `src/cli.ts`, `src/commands/workflow.ts`) over the
// durable `NoticesRepository` (issue #400). `tests/workflow-notices-tool.test.ts`
// proves the tool surface with a real sqlite store, no network;
// `tests/workflow-notices-cross-process.test.ts` proves the CLI surface
// across three real spawned processes (write under fence, list+ack, list
// again).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-notices-tool.test.ts", "tests/workflow-notices-cross-process.test.ts"],
} satisfies Declaracao;
