// Issue #424 (M10-S3, épico #421): tool `workflow_steer` (`src/workflow/steer-tool.ts`,
// registered in `src/commands/session-tools.ts`) — an operator-origin steer
// at a node/leaf named by `node_id` or `sub_id`, resolved through the run's
// audit ledger and delivered via `AuditedChildRuntime.steer(...,
// "operator")` (S2, #423) so `leaf.steered {source: "operator"}` lands for
// real. `tests/workflow-steer-tool.test.ts` proves registration, exclusion
// from subagents, resolution (node_id/sub_id, ambiguous, unknown, already
// finished), and the real ledger event with a live `WorkflowService` run.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-steer-tool.test.ts"],
} satisfies Declaracao;
