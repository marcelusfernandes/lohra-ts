// Issue #365: the three audit/live producers `WorkflowService` used to keep
// as private methods (`forwardEvent`, `announcePlan`, `announceDone`,
// `service.ts:473-551` on main 7fd10ea2) move here so the `segment_id` this
// issue adds to every event has ONE place to land — `service.ts` is at its
// zero-growth ceiling (1370 lines) and the extraction is what pays for the
// lines the identity work needs.
//
// Every event this factory emits to the audit trail carries the SAME
// `segmentId`: one per ACQUISITION (`WorkflowService.launch`/`launchDurable`
// each mint a fresh one via `idSource()`, the same source `runId` uses), so
// a resume's stretch and the stretch before it never share an identity —
// `AuditRepository.query({runId, segmentId})` can always separate them.
import { auditedWorkflowCache } from "./audit-cache.js";
import type { AuditInput } from "./audit-model.js";
import type { AuditTrail } from "./audit-trail.js";
import type { WorkflowCache } from "./cache.js";
import type { WorkflowEvent } from "./engine-contract.js";
import { type WorkflowLiveEvent, type WorkflowLiveEvents } from "./live-events.js";
import type { WorkflowSpec } from "./types.js";
import type { Ownership } from "../state/workflow-repository.js";

export interface WorkflowAuditProducersDeps {
  readonly trail: AuditTrail | undefined;
  readonly live: WorkflowLiveEvents;
  readonly runId: string;
  readonly segmentId: string;
  /** `stretchOwnership` in the durable path; `() => null` outside it — read
   * FRESH on every call, never captured once at construction time. */
  readonly ownershipOf: () => Ownership | null;
  /** `true` only for `launchDurable`: the fail-closed drop below only
   * applies where a fence exists to lose in the first place. */
  readonly durable: boolean;
  readonly warn: (message: string) => void;
  /** The service's own generic event hook (`options.onEvent`), forwarded
   * unconditionally — unlike the ledger write, it is never gated on
   * ownership (it always was, `service.ts:474` on main). */
  readonly onEvent: ((event: WorkflowEvent) => void) | undefined;
}

export interface WorkflowAuditProducers {
  readonly forwardEvent: (event: WorkflowEvent) => void;
  readonly announcePlan: (
    spec: WorkflowSpec,
    budget: Readonly<{ total: number; spent: number; remaining: number }> | null,
  ) => void;
  readonly announceDone: (status: string) => void;
  /** Issue #368: the FIRST event of a stretch, before `workflow.plan` —
   * `attempt` is 1 on a fresh `launch`, `(priorView.attempts ?? 0) + 1` on a
   * durable resume (the same count `pausePayload`'s own `attempts` field
   * already uses, service.ts). */
  readonly announceSegmentStarted: (attempt: number) => void;
  /** The LAST event of a stretch, before `workflow.done` — `status` is
   * whatever `announceDone` is about to publish (`"complete"`, `"paused"`,
   * `"cancelled"`, or `"failed"` from the `.catch` path). `cause: "signal"`
   * (issue #428, a SIGTERM/SIGINT shutdown, never a plain `cancel(runId)`)
   * overrides the payload to `{status: "interrupted", reason: "signal"}` —
   * the engine's own `status` stays `"cancelled"` either way (service.ts),
   * only the LEDGER tells the two apart. A `cancel(runId)` with no signal
   * cause still names itself: `status === "cancelled"` without `cause` gets
   * `reason: "cancelled"` in the payload, so a ledger reader never has to
   * infer "not signal" from an absent field. */
  readonly announceSegmentCompleted: (status: string, cause?: "signal" | null) => void;
  /** Issue #368: a dead-owner resume (`orphaned`, service.ts) closes the
   * PRIOR segment as `interrupted`/`process_crash` — under THIS stretch's
   * new fence, naming the OLD segment by id (or none, for a run durable
   * before the identity issue ever stamped one) — and follows it with an
   * `audit.gap` naming the same reason. Distinguishes "the process died"
   * from `sink_failure` (audit-trail.ts), the only other producer of
   * `audit.gap` today. */
  readonly announceProcessCrash: (priorSegmentId: string | null) => void;
  /** One `node.paused` per pause, `reason` mirroring `result.pauseReason`
   * (`CHECKPOINT_PAUSE`/`QUOTA_PAUSE`/`TOKEN_BUDGET_PAUSE`/`USER_PAUSE`,
   * service.ts:80-83). `checkpoint` is `result.checkpoint`: for a checkpoint
   * pause it already carries `node_id` (`checkpointPausePayload`,
   * engine-utils.ts); every other reason falls back to the last node this
   * factory saw `workflow.node{state:"running"}` for for — `workflow.node`/
   * `workflow.fault` themselves are UNCHANGED (decision of the
   * orchestrator, issue #368: never duplicated, never replaced). A `null`
   * `reason` is a no-op — the terminal write always calls this, whether the
   * run paused or not. */
  readonly announceNodePaused: (reason: string | null, checkpoint: unknown) => void;
  /** `service.ts`'s ONE call per acquisition, replacing a bare
   * `announcePlan` — `announceSegmentStarted` then `announcePlan`, in that
   * order (segment.started is the FIRST event of the stretch). */
  readonly announceStretchStart: (
    attempt: number,
    spec: WorkflowSpec,
    budget: Readonly<{ total: number; spent: number; remaining: number }> | null,
  ) => void;
  /** `service.ts`'s ONE call per terminal write, replacing a bare
   * `announceDone` — `announceNodePaused` (a no-op unless `status ===
   * "paused"`), then `announceSegmentCompleted`, then `announceDone`, in
   * that order (segment.completed is the LAST event before workflow.done).
   * `cause` is `record.interruptCause` (service.ts, #428): `"signal"` for a
   * run cancelled by `runShutdown("signal")`, `null` for everything else
   * (a plain `cancel(runId)`, a non-signal `shutdown()`, or a run that
   * simply finished). */
  readonly announceStretchEnd: (
    status: string,
    pauseReason: string | null,
    checkpoint: unknown,
    cause?: "signal" | null,
  ) => void;
  /** `service.ts`'s ONE call at the cache-construction site — decorates
   * `inner` with THIS stretch's own identity (`audit-cache.ts`, #368), so a
   * cell recomputed or replayed anywhere the engine reads/writes this cache
   * (including a nested workflow's inherited `this.cache`) is auditable. */
  readonly wrapCache: (inner: WorkflowCache) => WorkflowCache;
  /** `service.ts`'s `finishStretch`, called BEFORE it releases this
   * stretch's lease — issue #368 emenda (2026-09-11): `AuditTrail.record`
   * only enqueues; the terminal events `announceStretchEnd` just queued
   * (segment.completed, node.paused, workflow.done) would otherwise still
   * be sitting there when the lease disappears, and `AuditRepository.append`
   * refuses them under a fence that is no longer current — silently, before
   * this fix. Draining HERE, still under the live fence, closes that race.
   * A flush that fails or times out is named via `warn`, never swallowed —
   * the caller still releases the lease either way (a stuck sink must not
   * pin it forever, invariant 3). */
  readonly flushBeforeRelease: () => Promise<void>;
}

/** The subset of `WorkflowAuditProducersDeps` the fail-closed rule below
 * needs — issue #367 also reuses it from `audit-runtime.ts`'s `tool.*`/
 * `leaf.*` producer, which has no `live`/`segmentId`/`onEvent` of its own. */
export interface AuditFailClosedDeps {
  readonly trail: AuditTrail | undefined;
  /** `stretchOwnership` in the durable path; `() => null` outside it — read
   * FRESH on every call, never captured once at construction time. */
  readonly ownershipOf: () => Ownership | null;
  /** `true` only for the durable path: the fail-closed drop below only
   * applies where a fence exists to lose in the first place. */
  readonly durable: boolean;
  readonly warn: (message: string) => void;
}

/**
 * The fail-closed rule every audit producer in this codebase shares
 * (invariant 4, CLAUDE.md): `AuditRepository.append` skips its own fence
 * check whenever `ownership` is `undefined` — passing `ownershipOf() ??
 * undefined` straight through (what `service.ts:861-862` did on main, #365)
 * let a stretch that had lost ownership keep writing to the ledger with no
 * fence at all. Here, a durable stretch whose `ownershipOf()` returns `null`
 * never reaches `trail.record` — the event is dropped, named, via `warn` —
 * instead of being written unfenced.
 */
export function recordAuditEvent(
  deps: AuditFailClosedDeps,
  runId: string,
  input: AuditInput,
): void {
  const { trail, ownershipOf, durable, warn } = deps;
  if (trail === undefined) return;
  const ownership = ownershipOf();
  if (durable && ownership === null) {
    warn(`workflow: audit event dropped for run ${runId} — ownership lost (${input.event_type})`);
    return;
  }
  trail.record(runId, input, ownership ?? undefined);
}

/** Builds the three `workflow.*` producers for ONE acquisition — see
 * `recordAuditEvent` above for the fail-closed rule they share. */
export function createWorkflowAuditProducers(
  deps: WorkflowAuditProducersDeps,
): WorkflowAuditProducers {
  const { trail, live, runId, segmentId, ownershipOf, durable, warn, onEvent } = deps;
  const failClosed: AuditFailClosedDeps = { trail, ownershipOf, durable, warn };
  // `announceNodePaused`'s fallback identity (quota/budget/user_requested —
  // never the checkpoint reason, which carries its own `node_id`): the last
  // node this factory saw `workflow.node{state:"running"}` for.
  let lastRunningNode: string | null = null;

  function record(input: Omit<AuditInput, "segment_id">): void {
    recordAuditEvent(failClosed, runId, {
      ...input,
      segment_id: segmentId,
    });
  }

  function forwardEvent(event: WorkflowEvent): void {
    onEvent?.(Object.freeze({ ...event }));
    const nodeId = event.nodeId;
    if (event.kind === "node" && event.state === "running") lastRunningNode = nodeId;
    const liveEvent: WorkflowLiveEvent =
      event.kind === "fault"
        ? Object.freeze({
            kind: "fault",
            run_id: runId,
            node_id: nodeId,
            fault: event.text ?? "workflow fault",
          })
        : event.kind === "items"
          ? Object.freeze({
              kind: "items",
              run_id: runId,
              node_id: nodeId,
              ...(event.done === undefined ? {} : { done: event.done }),
              ...(event.total === undefined ? {} : { total: event.total }),
            })
          : Object.freeze({
              kind: "node",
              run_id: runId,
              node_id: nodeId,
              ...(event.state === undefined ? {} : { state: event.state }),
            });
    live.emit(liveEvent);
    record({
      event_type: `workflow.${liveEvent.kind}`,
      node_id: nodeId,
      payload:
        event.kind === "fault"
          ? { state: "fault", content: event.text ?? "" }
          : { state: event.state ?? "observed", done: event.done, total: event.total },
    });
  }

  function announcePlan(
    spec: WorkflowSpec,
    budget: Readonly<{ total: number; spent: number; remaining: number }> | null,
  ): void {
    const nodes = spec.nodes.map((node) => node.id);
    live.emit(
      Object.freeze({
        kind: "plan",
        run_id: runId,
        name: spec.name,
        nodes,
        ...(budget === null ? {} : { budget }),
      }),
    );
    record({
      event_type: "workflow.plan",
      payload: { name: spec.name, budget, node_path: nodes },
    });
  }

  function announceDone(status: string): void {
    live.emit(Object.freeze({ kind: "done", run_id: runId, state: status }));
    record({ event_type: "workflow.done", payload: { status, terminal: true } });
  }

  function announceSegmentStarted(attempt: number): void {
    record({ event_type: "segment.started", payload: { attempt, status: "running" } });
  }

  function announceSegmentCompleted(status: string, cause?: "signal" | null): void {
    if (cause === "signal") {
      record({
        event_type: "segment.completed",
        payload: { status: "interrupted", reason: "signal", terminal: true },
      });
      return;
    }
    const reason = status === "cancelled" ? { reason: "cancelled" } : {};
    record({ event_type: "segment.completed", payload: { status, ...reason, terminal: true } });
  }

  // Bypasses `record` on purpose: BOTH events below name the segment THIS
  // stretch is superseding, never `segmentId` (this stretch's own, which
  // `announceSegmentStarted` already stamped). `recordAuditEvent` still
  // presents `ownershipOf()` — THIS stretch's fence, the new one — so a
  // dead owner's abandoned segment is closed under a fence it never held.
  function announceProcessCrash(priorSegmentId: string | null): void {
    recordAuditEvent(failClosed, runId, {
      event_type: "segment.completed",
      ...(priorSegmentId === null ? {} : { segment_id: priorSegmentId }),
      payload: { status: "interrupted", reason: "process_crash" },
    });
    recordAuditEvent(failClosed, runId, {
      event_type: "audit.gap",
      payload: { reason: "process_crash", count_state: "unavailable" },
    });
  }

  function announceNodePaused(reason: string | null, checkpoint: unknown): void {
    if (reason === null) return;
    const fromCheckpoint =
      checkpoint !== null && typeof checkpoint === "object" && "node_id" in checkpoint
        ? (checkpoint as Readonly<Record<string, unknown>>).node_id
        : undefined;
    const nodeId = typeof fromCheckpoint === "string" ? fromCheckpoint : lastRunningNode;
    record({ event_type: "node.paused", node_id: nodeId, payload: { reason } });
  }

  function announceStretchStart(
    attempt: number,
    spec: WorkflowSpec,
    budget: Readonly<{ total: number; spent: number; remaining: number }> | null,
  ): void {
    announceSegmentStarted(attempt);
    announcePlan(spec, budget);
  }

  function announceStretchEnd(
    status: string,
    pauseReason: string | null,
    checkpoint: unknown,
    cause?: "signal" | null,
  ): void {
    announceNodePaused(pauseReason, checkpoint);
    announceSegmentCompleted(status, cause);
    announceDone(status);
  }

  function wrapCache(inner: WorkflowCache): WorkflowCache {
    return auditedWorkflowCache(inner, { trail, ownershipOf, durable, warn, segmentId });
  }

  async function flushBeforeRelease(): Promise<void> {
    if (trail === undefined) return;
    const ok = await trail.flush();
    if (!ok) warn(`workflow: audit flush before lease release failed for run ${runId}`);
  }

  return {
    forwardEvent,
    announcePlan,
    announceDone,
    announceSegmentStarted,
    announceSegmentCompleted,
    announceProcessCrash,
    announceNodePaused,
    announceStretchStart,
    announceStretchEnd,
    wrapCache,
    flushBeforeRelease,
  };
}
