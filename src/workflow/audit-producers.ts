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
import type { AuditInput } from "./audit-model.js";
import type { AuditTrail } from "./audit-trail.js";
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

  function record(input: Omit<AuditInput, "segment_id">): void {
    recordAuditEvent({ trail, ownershipOf, durable, warn }, runId, {
      ...input,
      segment_id: segmentId,
    });
  }

  function forwardEvent(event: WorkflowEvent): void {
    onEvent?.(Object.freeze({ ...event }));
    const nodeId = event.nodeId;
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

  return { forwardEvent, announcePlan, announceDone };
}
