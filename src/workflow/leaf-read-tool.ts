// Issue #425 (M10-S4): `workflow_leaf_read {run_id, sub_id, max_chars?}` — read
// the turns a still-running leaf has already COMMITTED, while it keeps
// working. Deliberately its own small module (`leaf-read-tool.ts`, not
// `tool.ts`), same convention `notices-tool.ts` (#402) and `workflowAuditHandler`
// already follow: this surface sits ALONGSIDE `WorkflowTool` in
// `src/commands/session-tools.ts`, not inside the class.
//
// "Partial" here means "turns already committed" — `conversation/runtime.ts`
// only calls `commitTurn` at the END of a turn (:578-586), so the turn
// currently in flight is never in `messages` and this tool can never surface
// it (see AC "Fora de escopo": would require changing `CollectOutcome`).
//
// Membership check: `sub_id` must (1) be a session with `source:'orchestration'`
// (`child-repository.ts:38-51` stamps every leaf that way) and (2) belong to
// `run_id`. For (2) this reads straight off the raw `better-sqlite3` handle
// and the already-built `AuditRepository` (both already in scope in
// `createSessionToolBase`) instead of adding a new SessionRepository method —
// `session-repository.ts` isn't in this issue's `Files` and `loadMessages`
// there drops the `timestamp` column this tool needs for `created_at`
// anyway. The CHEAP membership test (chosen over replaying the whole
// engine/spawn graph) is: does a `leaf.started` event for this `sub_id`
// exist anywhere in `run_id`'s audit ledger? `leaf.started` is written once,
// synchronously, at spawn (`audit-runtime.ts:211-228`), before the leaf can
// ever commit a turn, so it is always present for a real leaf and never for
// a `sub_id` that belongs to a different run (or none).
import type Database from "better-sqlite3";

import type { AuditRepository } from "../state/index.js";
import type { ToolHandler } from "../tools/types.js";

// #425 red: real implementation lands in the next commit — this stub only
// exists so the test file compiles and fails at RUNTIME (not at `tsc`).
export function workflowLeafReadHandler(
  _database: Database.Database,
  _auditRepository: AuditRepository,
): ToolHandler {
  throw new Error("not implemented: workflowLeafReadHandler");
}
