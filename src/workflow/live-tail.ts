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

// PR #381 round 2: an unbounded number of DISTINCT runs across a long
// process's lifetime is the same shape of growth `WorkflowService`'s own
// `this.runs` map already accepts (never trimmed either) — bounded here
// anyway, since this module is free to be stricter. Evicts the oldest run
// whose ring is already empty (a `done` run with nothing left to serve);
// only reaches for an active one if every tracked run is still active.
const KNOWN_RUNS_CAP = 1024;

export interface WorkflowLiveTailSnapshot {
  readonly events: readonly WorkflowLiveEvent[];
  /** Monotonic cursor: the caller's next `afterIndex`. Survives drops AND
   * survives `done`/`forget` — a run known this process never regresses
   * `next`/`dropped`, even across a same-process pause→auto-resume (PR
   * #381 round 2: `next_cursor` going backward after a `done{paused}` was
   * the exact silent-loss bug this counter design fixes). */
  readonly next: number;
  readonly dropped: number;
}

interface RingEntry {
  readonly cursor: number;
  readonly event: WorkflowLiveEvent;
  readonly bytes: number;
}

/** Event STORAGE only — cleared by `forget()`/`done`. */
interface Ring {
  readonly events: RingEntry[];
  totalBytes: number;
}

/** Bookkeeping that OUTLIVES `forget()` — a run's cursor and drop count are
 * true for the run's whole life in this process, not just since its ring
 * was last cleared. */
interface RunCounters {
  cursor: number;
  dropped: number;
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
  // the SAME store). Registered only AFTER a successful serialize (PR #381
  // round 2, minor c): a run whose every event so far failed to serialize
  // is not "known" yet — `push` still returns `false` and warns for each
  // one, so the failure is never silent, just not yet counted as presence.
  private readonly runs = new Map<string, RunCounters>();

  public constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** Whether THIS tail has ever pushed an event for `runId` — the signal
   * `workflow_status` uses to decide whether `live_tail` means anything. */
  public isKnown(runId: string): boolean {
    return this.runs.has(runId);
  }

  public push(event: WorkflowLiveEvent): boolean {
    const runId = event.run_id;
    if (event.kind === "done") {
      // `done` is a forget SIGNAL, not tail content: it never occupies a
      // cursor slot (PR #381 round 2 — counting it made a same-process
      // pause→resume's `next_cursor` overshoot what the caller could ever
      // see) and it is never itself stored, so it never needs draining.
      this.ensureRun(runId);
      this.forget(runId);
      return true;
    }
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch (error) {
      this.warn(
        `workflow: live tail failed to serialize a '${event.kind}' event for run ` +
          `${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const bytes = Buffer.byteLength(json, "utf8");
    const counters = this.ensureRun(runId);
    counters.cursor += 1;
    if (bytes > LIVE_TAIL_BYTES) {
      // Cannot ever fit alongside the cap on its own — counted, never
      // stored, and the EXISTING ring is left alone (PR #381 round 2,
      // minor a): evicting everything to make room for an event that can
      // never fit anyway would just be a second, needless loss.
      counters.dropped += 1;
      return true;
    }
    let ring = this.rings.get(runId);
    if (ring === undefined) {
      ring = { events: [], totalBytes: 0 };
      this.rings.set(runId, ring);
    }
    while (
      ring.events.length > 0 &&
      (ring.events.length >= LIVE_TAIL_EVENTS || ring.totalBytes + bytes > LIVE_TAIL_BYTES)
    ) {
      const removed = ring.events.shift();
      if (removed !== undefined) {
        ring.totalBytes -= removed.bytes;
        counters.dropped += 1;
      }
    }
    ring.events.push({ cursor: counters.cursor, event: freezeLiveEvent(event), bytes });
    ring.totalBytes += bytes;
    return true;
  }

  public snapshot(runId: string, afterIndex = 0): WorkflowLiveTailSnapshot {
    const counters = this.runs.get(runId);
    if (counters === undefined) return EMPTY_SNAPSHOT;
    const ring = this.rings.get(runId);
    // A cursor pointing past what the (possibly forgotten/reset) ring still
    // holds returns whatever survives after it — never throws, never lies
    // about `next`/`dropped`.
    const events =
      ring === undefined
        ? []
        : ring.events.filter((entry) => entry.cursor > afterIndex).map((entry) => entry.event);
    return Object.freeze({
      events: Object.freeze(events),
      next: counters.cursor,
      dropped: counters.dropped,
    });
  }

  /** Releases a run's RING (the event bytes) — never its counters. A run
   * this tail has ever known keeps an accurate `next`/`dropped` for the
   * rest of the process's life (mirrors `WorkflowService`'s own `this.runs`
   * never dropping a settled record). Called automatically on `done`. */
  public forget(runId: string): void {
    this.rings.delete(runId);
  }

  private ensureRun(runId: string): RunCounters {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing;
    const counters: RunCounters = { cursor: 0, dropped: 0 };
    this.runs.set(runId, counters);
    this.capRuns();
    return counters;
  }

  private capRuns(): void {
    if (this.runs.size <= KNOWN_RUNS_CAP) return;
    for (const id of this.runs.keys()) {
      if (!this.rings.has(id)) {
        this.runs.delete(id);
        return;
      }
    }
    // Pathological: every tracked run still has a live ring. Evict the
    // oldest anyway — invariant 3 (never unbounded) outranks perfect
    // bookkeeping for a run this process would otherwise track forever.
    const oldest = this.runs.keys().next().value;
    if (oldest !== undefined) {
      this.runs.delete(oldest);
      this.rings.delete(oldest);
    }
  }
}
