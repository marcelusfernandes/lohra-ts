// Issue #369: a per-process ring buffer of live workflow events, bounded by
// BOTH event count (LIVE_TAIL_EVENTS) and serialized bytes (LIVE_TAIL_BYTES
// — the same 64 KiB régua as `audit-model.ts`'s public event cap), oldest
// first. `dropped` is exposed per run, never silent (CLAUDE.md invariant
// 2); the cap is never crossed either way (invariant 3). `push` never
// throws — same rule as `WorkflowLiveEvents.emit` (`live-events.ts:45-51`):
// a live observer failing never aborts the run it is watching. Reads
// (`snapshot`) are frozen copies; the ring itself is the only mutable
// state, and it is private.
import type { WorkflowLiveEvent } from "./live-events.js";

export const LIVE_TAIL_EVENTS = 256;
export const LIVE_TAIL_BYTES = 64 * 1024;

export interface WorkflowLiveTailSnapshot {
  readonly events: readonly WorkflowLiveEvent[];
  /** Monotonic cursor: the caller's next `afterIndex`. Survives drops —
   * never an array index. */
  readonly next: number;
  readonly dropped: number;
}

interface RingEntry {
  readonly cursor: number;
  readonly event: WorkflowLiveEvent;
  readonly bytes: number;
}

interface Ring {
  readonly events: RingEntry[];
  totalBytes: number;
  dropped: number;
  cursor: number;
}

function freezeLiveEvent(event: WorkflowLiveEvent): WorkflowLiveEvent {
  return Object.freeze({
    ...event,
    ...(event.nodes === undefined ? {} : { nodes: Object.freeze([...event.nodes]) }),
    ...(event.budget === undefined ? {} : { budget: Object.freeze({ ...event.budget }) }),
  });
}

const EMPTY_SNAPSHOT: WorkflowLiveTailSnapshot = Object.freeze({
  events: Object.freeze([]),
  next: 0,
  dropped: 0,
});

export class WorkflowLiveTail {
  private readonly rings = new Map<string, Ring>();
  // Issue #369 AC 5: `workflow_status.live_tail` must appear ONLY for a run
  // this exact tail has actually observed a live event for — never for a
  // run known only durably (a different process's run, read back through
  // the SAME store). `forget()` clears the RING (bounded memory of the
  // events themselves) but never this set: a run this process finished
  // stays "known" here for the rest of the process's life, same as
  // `WorkflowService`'s own `this.runs` map never drops a settled record.
  private readonly knownRuns = new Set<string>();

  public constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** Whether THIS tail has ever pushed an event for `runId` — the signal
   * `workflow_status` uses to decide whether `live_tail` means anything. */
  public isKnown(runId: string): boolean {
    return this.knownRuns.has(runId);
  }

  public push(event: WorkflowLiveEvent): boolean {
    this.knownRuns.add(event.run_id);
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch (error) {
      this.warn(
        `workflow: live tail failed to serialize a '${event.kind}' event for run ` +
          `${event.run_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    const ring = this.rings.get(event.run_id) ?? {
      events: [],
      totalBytes: 0,
      dropped: 0,
      cursor: 0,
    };
    if (!this.rings.has(event.run_id)) this.rings.set(event.run_id, ring);
    ring.cursor += 1;
    while (
      ring.events.length > 0 &&
      (ring.events.length >= LIVE_TAIL_EVENTS || ring.totalBytes + bytes > LIVE_TAIL_BYTES)
    ) {
      const removed = ring.events.shift();
      if (removed !== undefined) {
        ring.totalBytes -= removed.bytes;
        ring.dropped += 1;
      }
    }
    if (bytes > LIVE_TAIL_BYTES) {
      // Cannot ever fit alongside the cap on its own — counted, never
      // stored, the snapshot invariant (<= LIVE_TAIL_BYTES) still holds.
      ring.dropped += 1;
    } else {
      ring.events.push({ cursor: ring.cursor, event: freezeLiveEvent(event), bytes });
      ring.totalBytes += bytes;
    }
    if (event.kind === "done") this.forget(event.run_id);
    return true;
  }

  public snapshot(runId: string, afterIndex = 0): WorkflowLiveTailSnapshot {
    const ring = this.rings.get(runId);
    if (ring === undefined) return EMPTY_SNAPSHOT;
    const events = ring.events
      .filter((entry) => entry.cursor > afterIndex)
      .map((entry) => entry.event);
    return Object.freeze({
      events: Object.freeze(events),
      next: ring.cursor,
      dropped: ring.dropped,
    });
  }

  public forget(runId: string): void {
    this.rings.delete(runId);
  }
}
