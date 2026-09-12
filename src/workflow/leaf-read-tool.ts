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
// `run_id`'s audit ledger?
//
// IMPORTANT (round 2 correction): `leaf.started` is NOT a guaranteed,
// synchronous write. `audit-runtime.ts:216-233` calls `AuditTrail.record`
// (`audit-producers.ts`'s `recordAuditEvent`), which only ENQUEUES the event
// — a background loop flushes it to sqlite later (`audit-trail.ts:59+`).
// The event can be missing for a REAL leaf of a REAL run for reasons that
// have nothing to do with `sub_id`/`run_id` being wrong: the audit trail can
// be entirely absent (`trail === undefined`, e.g. `LOHRA_AUDIT` off —
// `recordAuditEvent` returns immediately), the in-memory queue can be full
// and drop it, the writer can already be closing/stopped, or
// `AuditRepository`'s own retention/eviction (`AUDIT_RUN_CAP`, tombstones)
// can have pruned the run's ledger by the time this tool reads it. This
// tool stays FAIL-CLOSED on every one of those: it never falls back to
// "the session row alone proves it", so a dropped/pruned/disabled ledger
// makes a real leaf read back as "does not belong to run" instead of
// silently trusting an unverifiable claim (invariant 2) — a known,
// documented cost of the cheap check, not a bug.
import type Database from "better-sqlite3";

import type { AuditRepository } from "../state/index.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";

const DEFAULT_MAX_CHARS = 4096;
const MAX_MAX_CHARS = 32768;
// Named, bounded read (invariant 3 — budget/fan-out never unbounded): a live
// leaf's `messages` table has no cap of its own, so this tool never fetches
// more than the MOST RECENT `MAX_TURNS` rows — the ones a supervising
// operator actually cares about. `workflow_audit`'s own page limit (100,
// `AuditQuery.limit`) bounds a DIFFERENT thing (one page of the event log,
// with a cursor to page further) — this tool has no cursor, so 200 is a
// looser but still-named ceiling for the whole conversation window, not a
// page size.
const MAX_TURNS = 200;
const NOTE =
  "turnos assentados; o turno em voo não está gravado. role 'tool' vem com a saída bruta, sem redigir (diferente de workflow_audit). O orçamento de max_chars é gasto do turno MAIS RECENTE para o mais antigo, então turns.at(-1) nunca volta cortado por causa de turnos antigos — quando o orçamento estoura, são os turnos mais antigos que voltam com content:''. A checagem de posse depende de leaf.started ainda estar na auditoria — auditoria desligada ou evento podado/despejado nega em vez de fingir sucesso.";

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

// #435: `rowsDesc` MUST already be ordered most-recent-first — the budget is
// spent walking that order, so the MOST RECENT turn is always filled first
// and, when the budget runs out, it is the OLDEST turns that come back
// empty instead of the newest. The caller reverses the result back to
// chronological order for the reply; this function never reorders.
function truncateTurns(
  rowsDesc: readonly MessageTurnRow[],
  maxChars: number,
): { readonly turns: readonly LeafTurn[]; readonly truncated: boolean } {
  let budget = maxChars;
  let truncated = false;
  const turns = rowsDesc.map((row): LeafTurn => {
    if (row.content === null) return { role: row.role, content: null, created_at: row.timestamp };
    // An already-empty turn is never a cut — even with the budget already at
    // zero, there is nothing to slice, so this must NOT flip `truncated`
    // (round 2 fix, #432: the old order checked `budget <= 0` first and
    // reported a false positive for a turn that was empty all along).
    if (row.content.length === 0) return { role: row.role, content: "", created_at: row.timestamp };
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

    // Fetch the MOST RECENT `MAX_TURNS + 1` rows (DESC) — the `+1` is only
    // to detect "there is at least one more beyond the cap" without a
    // separate COUNT query — then drop the extra (oldest of the fetched
    // batch). The rows STAY in DESC (most-recent-first) order for
    // `truncateTurns` (#435: the char budget must be spent from the most
    // recent turn backward, so a busy conversation never comes back with an
    // empty tail); only the OUTPUT is restored to chronological order.
    const fetchedDesc = database
      .prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE session_id = ? AND active = 1
         ORDER BY id DESC LIMIT ?`,
      )
      .all(subId, MAX_TURNS + 1) as readonly MessageTurnRow[];
    const truncatedTurns = fetchedDesc.length > MAX_TURNS;
    const rowsDesc = truncatedTurns ? fetchedDesc.slice(0, MAX_TURNS) : fetchedDesc;
    const { turns: turnsDesc, truncated } = truncateTurns(rowsDesc, maxChars);
    const turns = Object.freeze([...turnsDesc].reverse());

    return toolResult(undefined, {
      sub_id: subId,
      run_id: runId,
      turns,
      truncated,
      truncated_turns: truncatedTurns,
      note: NOTE,
    });
  };
}
