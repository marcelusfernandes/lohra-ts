// Issue #424 (M10-S3, épico #421): `workflow_steer {run_id, node_id? |
// sub_id?, message}` — deliberately its own small module (`steer-tool.ts`,
// not `tool.ts`), same convention `notices-tool.ts` (#402) and
// `leaf-read-tool.ts` (#425) already follow: this surface sits ALONGSIDE
// `WorkflowTool` in `src/commands/session-tools.ts`, not inside the class.
//
// Resolution (`node_id -> sub_id`, or a bare `sub_id` membership check)
// reads the run's own audit ledger — never `WorkflowEngine`'s in-memory
// `activeLeaves` (a private `Set<string>`, no public accessor, and
// `engine.ts` is out of this issue's `Files`) and never
// `OrchestrationChildRuntime`'s `causalContexts` map alone (populated at
// spawn, swept only at `dispose()` — i.e. at the END of the whole stretch,
// so it cannot tell a COMPLETED leaf from a still-running one on its own;
// `orchestration-runtime.ts` is out of Files past its one comment). "live"
// here means: a `leaf.started` event exists for this `sub_id`/`node_id`
// and no `leaf.completed`/`leaf.failed` has landed yet — the SAME
// fail-closed membership posture `leaf-read-tool.ts:13-40` documents (audit
// disabled, its queue full, or the run's ledger already pruned all read
// back as "no live leaf", never a silent guess). Because the ledger write
// is enqueued, not synchronous (`AuditTrail.record` — `audit-runtime.ts`),
// a caller in the SAME turn as a spawn may need `workflow_audit`'s own
// flush semantics to see it; this tool does not flush itself (steering is
// not a read of history, and forcing a flush here would make an operator
// action pay for the audit trail's own latency).
//
// Delivery goes through `WorkflowService.liveRuntimeOf(runId)` —
// `service.ts`'s per-stretch `AuditedChildRuntime` — NEVER a fresh
// `auditedRuntimeFor`/`auditInstall` call: a new decorator instance mints
// an empty `identities` map, and its `steer` silently skips the
// `leaf.steered` event (audit-runtime.ts's fail-open-to-the-port branch)
// even though the underlying `core.steer` still runs. `runtime.steer(subId,
// message, causal, "operator")`'s 4th parameter is what makes S2's audit
// event carry `source: "operator"` instead of the engine's own default.
//
// S1's per-leaf cap (`MAX_PENDING_STEERS_PER_LEAF`, core.ts) IS observable
// here (2ª emenda, 2026-09-12 — closes the gap the first version of this
// file's comment left open, flagged on the issue and the PR): both
// `OrchestrationChildRuntime.steer` (orchestration-runtime.ts) and
// `AuditedChildRuntime.steer` (audit-runtime.ts) now forward `core.steer`'s
// own `{queued, refused?} | null` instead of discarding it, so `refused:
// "steer_cap"` and `null` (a terminal/unknown leaf at the core, distinct
// from "no live leaf" per the ledger above — a genuine race, not this
// tool's own resolution) both come back as a NAMED error, never `queued:
// true` for a steer the core actually dropped (invariant 2: falha nunca é
// silenciosa). `queued: true` in the response is now the core's own word,
// not this tool's guess.
import { MAX_PENDING_STEERS_PER_LEAF } from "../orchestration/core.js";
import type { AuditRepository } from "../state/index.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { AuditedChildRuntime } from "./audit-runtime.js";

/** Same wording family as `orchestration/tools.ts`'s own `steerCapMessage`
 * (`steer_session`) — a different tool, same refusal, same shape. */
function steerCapMessage(subId: string): string {
  return `workflow_steer refused: steer_cap (${String(MAX_PENDING_STEERS_PER_LEAF)} pending steers on ${subId})`;
}

// Issue #445 (M14, follow-up of #421, flagged in M10 review): the ORIGINAL
// resolution read exactly one `AuditRepository.query` page per event type
// (`limit: MAX_LEAVES`) and trusted it as the whole ledger — a run past 100
// `leaf.started` silently lost every `sub_id` beyond that window (the page
// is oldest-seq-first, `audit-repository.ts:395`), so `workflow_steer`
// reported "no live leaf" for a leaf that genuinely existed. Two different
// fixes for the two different resolution shapes this tool has:
//
//   - `sub_id` given (`isLiveSubId`): `AuditQuery.subId` is an EXACT
//     identity filter (`audit-repository.ts:118`, `matches()`), not a
//     window — a query scoped to one `sub_id` only ever matches that
//     leaf's own handful of events, so it is immune to the 100-event
//     window regardless of how many OTHER leaves the run has spawned.
//     Direct query, never a scan.
//   - `node_id` given (`liveSubIdsAtNode`): resolving a bare `node_id`
//     genuinely needs the FULL live set at that node (ambiguity is a
//     count, not a membership check), so this one still has to read pages
//     — now chained with `afterSeq`/`has_more` until the ledger says
//     `has_more: false`, capped at `MAX_RESOLUTION_EVENTS` (bounded read,
//     invariant 3) so a pathological node can never make this tool loop
//     unbounded. Above the cap: a NAMED "window truncated" error, never a
//     silent "no live leaf" for a node this tool never finished reading.
//
// `MAX_LEAVES` stays exactly what `AuditRepository.query` itself clamps a
// single page to (`audit-repository.ts:321`) — a per-page size, not a
// resolution ceiling anymore.
const MAX_LEAVES = 100;

/** Ceiling on how many ledger events `liveSubIdsAtNode` may read while
 * paginating a `node_id` resolution (issue #445) — same spirit as
 * `MAX_TURNS` (`leaf-read-tool.ts`): a named, bounded read, never an
 * unbounded scan of a run's whole ledger. 2000 is generous for the runs
 * this tool steers (a live leaf-count in the hundreds, not thousands) while
 * still being a real, checkable limit. Does NOT apply to the `sub_id` path
 * (`isLiveSubId`), which never paginates. */
const MAX_RESOLUTION_EVENTS = 2_000;

/** The one thing this tool needs from `WorkflowService` — kept minimal so a
 * test can hand it a fake `liveRuntimeOf` instead of a real service. */
export interface SteerableService {
  liveRuntimeOf(runId: string): AuditedChildRuntime | undefined;
}

function requireString(args: ToolArguments, key: string): string | { readonly error: string } {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "")
    return { error: `workflow_steer requires a non-empty string '${key}'` };
  return value;
}

/** `""` means "omitted" — the same absence idiom `workflow_leaf_read`'s
 * `parseMaxChars` and `workflow_audit`'s query parsing already use for a
 * strict-schema caller that fills every optional field instead of omitting
 * it. */
function optionalString(args: ToolArguments, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringField(identity: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = identity[key];
  return typeof value === "string" ? value : undefined;
}

function nodeIdOfIdentity(identity: Readonly<Record<string, unknown>>): string | undefined {
  const path = identity.node_path;
  return Array.isArray(path) && typeof path[0] === "string" ? path[0] : undefined;
}

/** The `node_id` a live `sub_id` started at, straight from its own
 * `leaf.started` event — never re-derived from `node_id` filtering (a
 * caller resolving by `sub_id` never supplied one). */
function nodeIdOfSubId(audit: AuditRepository, runId: string, subId: string): string | undefined {
  const page = audit.query({ runId, subId, eventType: "leaf.started", limit: 1 });
  const identity = page.events[0]?.identity;
  return identity === undefined ? undefined : nodeIdOfIdentity(identity);
}

/** Whether `subId` has a `leaf.started` for this run and no
 * `leaf.completed`/`leaf.failed` yet — three DIRECT, `subId`-scoped
 * queries (`AuditQuery.subId` is an exact identity filter, never a window),
 * so this is immune to how many OTHER leaves the run has spawned (#445).
 * `limit: 1` on each: existence/absence is all this needs, never a count. */
function isLiveSubId(audit: AuditRepository, runId: string, subId: string): boolean {
  const started = audit.query({ runId, subId, eventType: "leaf.started", limit: 1 });
  if (started.events.length === 0) return false;
  const completed = audit.query({ runId, subId, eventType: "leaf.completed", limit: 1 });
  if (completed.events.length > 0) return false;
  const failed = audit.query({ runId, subId, eventType: "leaf.failed", limit: 1 });
  return failed.events.length === 0;
}

function hasMore(page: Readonly<Record<string, unknown>>): boolean {
  return page.has_more === true;
}

function nextAfterSeq(page: Readonly<Record<string, unknown>>, fallback: number): number {
  const value = page.next_after_seq;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A shared read budget across the (up to three) paginated queries
 * `liveSubIdsAtNode` issues — decremented per event actually read, so the
 * `MAX_RESOLUTION_EVENTS` ceiling counts real ledger reads, not query
 * round-trips. */
interface ReadBudget {
  remaining: number;
}

/** `sub_id`s from every `eventType` event at `nodeId`, paginated with
 * `afterSeq` until the ledger says `has_more: false` or `budget` runs out —
 * scoped to ONE event type per call, same as the original (pre-#445)
 * `scoped()` helper, so a busy leaf's OWN `tool.*`/`leaf.steered` traffic at
 * that node never counts against the ceiling meant for "how many leaves has
 * this node ever started/finished". */
function pagedSubIds(
  audit: AuditRepository,
  runId: string,
  nodeId: string,
  eventType: string,
  budget: ReadBudget,
): { readonly ids: readonly string[]; readonly truncated: boolean } {
  const ids: string[] = [];
  let afterSeq = 0;
  for (;;) {
    if (budget.remaining <= 0) return { ids, truncated: true };
    const page = audit.query({ runId, nodeId, eventType, afterSeq, limit: MAX_LEAVES });
    for (const event of page.events) {
      budget.remaining -= 1;
      const id = stringField(event.identity, "sub_id");
      if (id !== undefined) ids.push(id);
    }
    if (!hasMore(page.page)) return { ids, truncated: false };
    const next = nextAfterSeq(page.page, afterSeq);
    if (next <= afterSeq) return { ids, truncated: false }; // defensive: no forward progress
    afterSeq = next;
  }
}

/** Live `sub_id`s at one `node_id` — unlike `isLiveSubId`, resolving a bare
 * `node_id` genuinely needs the full live set (ambiguity is a count, not a
 * membership check), so this one still has to read the ledger page by page,
 * bounded at `MAX_RESOLUTION_EVENTS` total events read across all three
 * queries (invariant 3): `truncated: true` means the caller must not trust
 * `liveSubIds` — it is incomplete, not "empty". */
function liveSubIdsAtNode(
  audit: AuditRepository,
  runId: string,
  nodeId: string,
): { readonly liveSubIds: readonly string[]; readonly truncated: boolean } {
  const budget: ReadBudget = { remaining: MAX_RESOLUTION_EVENTS };
  const started = pagedSubIds(audit, runId, nodeId, "leaf.started", budget);
  if (started.truncated) return { liveSubIds: [], truncated: true };
  const completed = pagedSubIds(audit, runId, nodeId, "leaf.completed", budget);
  if (completed.truncated) return { liveSubIds: [], truncated: true };
  const failed = pagedSubIds(audit, runId, nodeId, "leaf.failed", budget);
  if (failed.truncated) return { liveSubIds: [], truncated: true };
  const terminal = new Set([...completed.ids, ...failed.ids]);
  return { liveSubIds: started.ids.filter((id) => !terminal.has(id)), truncated: false };
}

function windowTruncatedError(runId: string, nodeId: string): { readonly error: string } {
  return {
    error:
      `workflow_steer: resolution window truncated after ${String(MAX_RESOLUTION_EVENTS)} ` +
      `events at node '${nodeId}' for run '${runId}' — use a more specific node_id or sub_id`,
  };
}

function resolveSubId(
  audit: AuditRepository,
  runId: string,
  nodeId: string | undefined,
  subIdArg: string | undefined,
): string | { readonly error: string } {
  if (subIdArg !== undefined) {
    if (!isLiveSubId(audit, runId, subIdArg))
      return { error: `workflow_steer: sub_id '${subIdArg}' has no live leaf for run '${runId}'` };
    return subIdArg;
  }
  const resolvedNodeId = String(nodeId);
  const window = liveSubIdsAtNode(audit, runId, resolvedNodeId);
  if (window.truncated) return windowTruncatedError(runId, resolvedNodeId);
  const candidates = window.liveSubIds;
  if (candidates.length === 0)
    return { error: `workflow_steer: no live leaf at node '${resolvedNodeId}' for run '${runId}'` };
  if (candidates.length > 1)
    return {
      error:
        `workflow_steer: node '${resolvedNodeId}' has ${String(candidates.length)} live leaves ` +
        "— ambiguous, use sub_id",
    };
  return candidates[0] as string;
}

export function workflowSteerHandler(
  service: SteerableService,
  audit: AuditRepository,
): ToolHandler {
  return async (args) => {
    const runId = requireString(args, "run_id");
    if (typeof runId !== "string") return toolError(runId.error);
    const message = requireString(args, "message");
    if (typeof message !== "string") return toolError(message.error);
    const nodeId = optionalString(args, "node_id");
    const subIdArg = optionalString(args, "sub_id");
    if ((nodeId === undefined) === (subIdArg === undefined))
      return toolError("workflow_steer requires exactly one of 'node_id' or 'sub_id'");

    const resolved = resolveSubId(audit, runId, nodeId, subIdArg);
    if (typeof resolved !== "string") return toolError(resolved.error);
    const subId = resolved;

    const runtime = service.liveRuntimeOf(runId);
    if (runtime === undefined) return toolError(`workflow_steer: run '${runId}' is not live`);

    const causal = (await runtime.causalSnapshot?.(subId)) ?? undefined;
    // Issue #450: `steerOutcome` is the typed member `AuditedChildRuntime`
    // exposes ONLY when the underlying runtime reports a real outcome
    // (`audit-runtime.ts`'s conditional spread) — `steer` itself stays
    // real `void` (the port). Absent means this runtime never reports an
    // outcome at all; fail-closed, a named error, never an invented
    // `queued: true`.
    if (runtime.steerOutcome === undefined) {
      return toolError(`workflow_steer: runtime sem steerOutcome for sub_id '${subId}'`);
    }
    const outcome = await runtime.steerOutcome(subId, message, causal, "operator");
    if (outcome === null)
      return toolError(`workflow_steer: sub_id '${subId}' is terminal or unknown to the core`);
    if (outcome.refused === "steer_cap") return toolError(steerCapMessage(subId));

    return toolResult(undefined, {
      sub_id: subId,
      node_id: nodeId ?? nodeIdOfSubId(audit, runId, subId) ?? null,
      queued: outcome.queued,
    });
  };
}
