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
// it (see the issue's "Fora de escopo": would require changing `CollectOutcome`).
//
// Membership check: `sub_id` must (1) be a session with `source:'orchestration'`
// (`child-repository.ts:38-51` stamps every leaf that way) and (2) belong to
// `run_id`. For (2) this reads straight off the raw `better-sqlite3` handle
// and the already-built `AuditRepository` (both already in scope in
// `createSessionToolBase`) instead of adding a new SessionRepository method —
// `session-repository.ts` isn't in this issue's `Files`, and its own
// `loadMessages` drops the `timestamp` column this tool needs for
// `created_at` anyway (`reconstructMessage` reshapes each row without it).
// The CHEAP membership test (chosen over replaying the whole engine/spawn
// graph) is: does a `leaf.started` event for this `sub_id` exist anywhere in
// `run_id`'s audit ledger? `leaf.started` is written once, synchronously, at
// spawn (`audit-runtime.ts:211-228`), strictly before the leaf can ever
// commit a turn, so it is always present for a real leaf of that run and
// never for a `sub_id` that belongs to a different run (or none).
import type Database from "better-sqlite3";

import type { AuditRepository } from "../state/index.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";

const DEFAULT_MAX_CHARS = 4096;
const MAX_MAX_CHARS = 32768;
const NOTE = "turnos assentados; o turno em voo não está gravado";

/** Same idiom as `notices-tool.ts`'s `integer()`: accepts a JSON number OR a
 * numeric string (a strict-schema caller sometimes stringifies), never
 * silently coerces anything else. */
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^[+-]?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : undefined;
}

/** `""`/`0` mean "use the default", the same absence idiom `workflow_notices`
 * and `workflow_audit` follow for a strict-schema caller that fills every
 * optional field instead of omitting it. Anything else that isn't a valid
 * integer is a named error (a genuine type mistake, not a range choice);
 * a valid integer is always CLAMPED into [1, MAX_MAX_CHARS] rather than
 * rejected — the same clamp-not-reject posture `AuditRepository.query`'s
 * own `limit` already uses for out-of-range values. */
function parseMaxChars(value: unknown): number | { readonly error: string } {
  if (value === undefined || value === "") return DEFAULT_MAX_CHARS;
  const parsed = integer(value);
  if (parsed === undefined) return { error: "workflow_leaf_read max_chars must be an integer" };
  if (parsed === 0) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(1, parsed));
}

function requireString(args: ToolArguments, key: string): string | { readonly error: string } {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "")
    return { error: `workflow_leaf_read requires a non-empty string '${key}'` };
  return value;
}

interface SessionSourceRow {
  readonly source: unknown;
}

interface MessageTurnRow {
  readonly role: string;
  readonly content: string | null;
  readonly timestamp: number;
}

interface LeafTurn {
  readonly role: string;
  readonly content: string | null;
  readonly created_at: number;
}

function truncateTurns(
  rows: readonly MessageTurnRow[],
  maxChars: number,
): { readonly turns: readonly LeafTurn[]; readonly truncated: boolean } {
  let budget = maxChars;
  let truncated = false;
  const turns = rows.map((row): LeafTurn => {
    if (row.content === null) return { role: row.role, content: null, created_at: row.timestamp };
    if (budget <= 0) {
      truncated = true;
      return { role: row.role, content: "", created_at: row.timestamp };
    }
    if (row.content.length > budget) {
      const sliced = row.content.slice(0, budget);
      budget = 0;
      truncated = true;
      return { role: row.role, content: sliced, created_at: row.timestamp };
    }
    budget -= row.content.length;
    return { role: row.role, content: row.content, created_at: row.timestamp };
  });
  return { turns: Object.freeze(turns), truncated };
}

export function workflowLeafReadHandler(
  database: Database.Database,
  auditRepository: AuditRepository,
): ToolHandler {
  return (args) => {
    const runId = requireString(args, "run_id");
    if (typeof runId !== "string") return toolError(runId.error);
    const subId = requireString(args, "sub_id");
    if (typeof subId !== "string") return toolError(subId.error);
    const maxChars = parseMaxChars(args.max_chars);
    if (typeof maxChars !== "number") return toolError(maxChars.error);

    const sessionRow = database.prepare("SELECT source FROM sessions WHERE id = ?").get(subId) as
      SessionSourceRow | undefined;
    if (sessionRow === undefined)
      return toolError(`workflow_leaf_read: sub_id '${subId}' not found`);
    if (sessionRow.source !== "orchestration")
      return toolError(`workflow_leaf_read: sub_id '${subId}' is not an orchestration leaf`);

    const membership = auditRepository.query({
      runId,
      subId,
      eventType: "leaf.started",
      limit: 1,
    });
    if (membership.events.length === 0)
      return toolError(`workflow_leaf_read: sub_id '${subId}' does not belong to run '${runId}'`);

    const rows = database
      .prepare(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND active = 1 ORDER BY id",
      )
      .all(subId) as readonly MessageTurnRow[];
    const { turns, truncated } = truncateTurns(rows, maxChars);

    return toolResult(undefined, {
      sub_id: subId,
      run_id: runId,
      turns,
      truncated,
      note: NOTE,
    });
  };
}
