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
// `queued: true` in the response is NOMINAL, not observed: S1's per-leaf
// cap (`MAX_PENDING_STEERS_PER_LEAF`, core.ts) can still refuse the text
// server-side, but `OrchestrationChildRuntime.steer` (orchestration-
// runtime.ts:270-271) and `AuditedChildRuntime.steer` (audit-runtime.ts)
// both discard `core.steer`'s own `{queued, refused?} | null` return value
// today — documented on the PR (#424) and flagged on the issue
// (2026-09-12) as a follow-up: widening those two `void` returns to forward
// `core.steer`'s outcome is two lines, both out of this issue's `Files`.
import type { AuditRepository, AuditQuery } from "../state/index.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { AuditedChildRuntime } from "./audit-runtime.js";

// Named, bounded read (invariant 3): one page of `leaf.started`/terminal
// events per query, same ceiling `AuditRepository.query` itself clamps to —
// never an unbounded scan of a run's whole ledger.
const MAX_LEAVES = 100;

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

function subIdsOf(audit: AuditRepository, query: AuditQuery): readonly string[] {
  return audit
    .query(query)
    .events.map((event) => stringField(event.identity, "sub_id"))
    .filter((id): id is string => id !== undefined);
}

/** `sub_id`s with a `leaf.started` for this run (optionally scoped to one
 * `node_id`) and no `leaf.completed`/`leaf.failed` yet. */
function liveSubIds(audit: AuditRepository, runId: string, nodeId?: string): readonly string[] {
  const scoped = (eventType: string): AuditQuery =>
    nodeId === undefined
      ? { runId, eventType, limit: MAX_LEAVES }
      : { runId, eventType, nodeId, limit: MAX_LEAVES };
  const started = subIdsOf(audit, scoped("leaf.started"));
  const terminal = new Set([
    ...subIdsOf(audit, scoped("leaf.completed")),
    ...subIdsOf(audit, scoped("leaf.failed")),
  ]);
  return started.filter((id) => !terminal.has(id));
}

/** The `node_id` a live `sub_id` started at, straight from its own
 * `leaf.started` event — never re-derived from `node_id` filtering (a
 * caller resolving by `sub_id` never supplied one). */
function nodeIdOfSubId(audit: AuditRepository, runId: string, subId: string): string | undefined {
  const page = audit.query({ runId, subId, eventType: "leaf.started", limit: 1 });
  const identity = page.events[0]?.identity;
  return identity === undefined ? undefined : nodeIdOfIdentity(identity);
}

function resolveSubId(
  audit: AuditRepository,
  runId: string,
  nodeId: string | undefined,
  subIdArg: string | undefined,
): string | { readonly error: string } {
  if (subIdArg !== undefined) {
    if (!liveSubIds(audit, runId).includes(subIdArg))
      return { error: `workflow_steer: sub_id '${subIdArg}' has no live leaf for run '${runId}'` };
    return subIdArg;
  }
  const candidates = liveSubIds(audit, runId, nodeId);
  if (candidates.length === 0)
    return { error: `workflow_steer: no live leaf at node '${String(nodeId)}' for run '${runId}'` };
  if (candidates.length > 1)
    return {
      error:
        `workflow_steer: node '${String(nodeId)}' has ${String(candidates.length)} live leaves ` +
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
    await runtime.steer(subId, message, causal, "operator");

    return toolResult(undefined, {
      sub_id: subId,
      node_id: nodeId ?? nodeIdOfSubId(audit, runId, subId) ?? null,
      queued: true,
    });
  };
}
