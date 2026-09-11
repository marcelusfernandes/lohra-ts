// Issue #401 (M8-5): unifies the eight ad hoc `console.warn` sinks this
// runtime carried (`docs`/epic #396 mapa §2) into ONE adapter per process.
// `warn`/`warnState` both keep printing to stderr — the dashboard/gateway's
// byte-fixed assertion (`src/gateway/failure-log.ts:4-10`) forbids adding a
// NEW console line, so every existing call site's own fallback is reused
// as-is — AND additionally record the same warning durably in
// `operator_notices` (`src/state/notices-repository.ts`, issue #400), so an
// operator can read it back from a DIFFERENT process after this one dies.
//
// `warn(message)` classifies a plain string by an EXPLICIT, ordered
// substring map (never a loose regex — CLAUDE.md invariant 2 is "no silent
// failure", which also rules out a silent MISCLASSIFICATION) and always
// writes to the `global` scope: a bare string carries no run identity.
//
// `warnState(warning)` handles the one TYPED warning this runtime has
// (`StateWarning`, `src/state/locks.ts:8-12`) and writes to `run:<runId>`.
// The fence INSIDE a `StateWarning` is the fence that just LOST
// (`src/state/workflow-repository.ts:45`, `src/state/locks.ts:205`; the
// write that raised it failed exactly because the row's real fence had
// already moved past it) — never valid to re-use for a write of our own.
// `ownership(runId)` lets the caller resolve the CURRENT fence instead
// (`LockRepository.runFenceOf`, `src/state/locks.ts:178`); a caller unable
// to resolve it (no store wired yet, or this process no longer holds the
// run's lease) returns `null` and the notice is dropped — counted, never
// thrown, this is the sink of last resort (`repository.append` itself
// never propagates a failure here either).
import { productionWarningSink } from "./ownership-store.js";
import type {
  NoticeInput,
  NoticeKind,
  Ownership,
  PublicNotice,
  StateWarning,
} from "../state/index.js";

const GLOBAL_SCOPE = "global";

/** Structural, not the concrete class — a test can pass a stub repository
 * that throws on `append` without satisfying every `NoticesRepository`
 * member. */
export interface NoticesSinkRepository {
  append(scope: string, input: NoticeInput, ownership?: Ownership): PublicNotice | null;
}

export interface NoticesSinkStats {
  readonly dropped: number;
}

export interface NoticesSink {
  readonly warn: (message: string) => void;
  readonly warnState: (warning: StateWarning) => void;
  readonly stats: () => NoticesSinkStats;
}

export interface NoticesSinkOptions {
  readonly repository: NoticesSinkRepository;
  readonly ownership?: (runId: string) => Ownership | null;
  /** The `console.warn` (or equivalent) an existing call site already
   * uses — this sink never removes it, only adds a durable write beside
   * it. */
  readonly fallback: (message: string) => void;
}

/** Ordered, explicit, literal substrings only — first match wins. Each row
 * is lifted from an ACTUAL producer's message, cited by source line, never
 * a pattern that could also match something unrelated. */
const KIND_MARKERS: ReadonlyArray<readonly [marker: string, kind: NoticeKind]> = [
  // src/workflow/audit-trail.ts:285 — AuditTrail.append's own drain
  // failure (the mutant W2 anchor test, tests/chat-audit-trail-wiring.ts,
  // matches this exact producer text through chat.ts's AuditTrail sink).
  ["audit append failed for run", "audit_sink_failure"],
  // src/workflow/audit-trail.ts:103 — the trail's bounded in-memory queue
  // overflowed and dropped an event.
  ["audit queue overflow for run", "queue_overflow"],
  // src/workflow/durability.ts:141,195,205 — AutoResumeScheduler. Named
  // here so the mapping is ready; NOT reachable from this sink in this
  // issue (the scheduler is constructed inside service.ts:420 with no
  // `logWarning` option threaded, and service.ts is zero-lines for #401).
  ["auto-resume", "resume_attempts_exhausted"],
];

function classify(message: string): NoticeKind {
  for (const [marker, kind] of KIND_MARKERS) {
    if (message.includes(marker)) return kind;
  }
  return "unknown";
}

export function createNoticesSink(options: NoticesSinkOptions): NoticesSink {
  const { repository, ownership, fallback } = options;
  let dropped = 0;

  function record(scope: string, kind: NoticeKind, message: string, owner?: Ownership): void {
    try {
      const result = repository.append(scope, { kind, message }, owner);
      if (result === null) dropped += 1;
    } catch {
      dropped += 1;
    }
  }

  function warn(message: string): void {
    fallback(message);
    record(GLOBAL_SCOPE, classify(message), message);
  }

  function warnState(warning: StateWarning): void {
    // Reuses `productionWarningSink`'s own formatting instead of
    // duplicating the `workflow: <cause> run=<runId> fence=<fence>`
    // string literal — the two can never drift apart, and the fallback
    // still sees exactly the format `tests/workflow-durable-roots.test.ts`
    // pins.
    let formatted = "";
    productionWarningSink((message) => {
      formatted = message;
      fallback(message);
    })(warning);
    const owner = ownership?.(warning.runId) ?? null;
    if (owner === null) {
      dropped += 1;
      return;
    }
    record(`run:${warning.runId}`, "stale_fence_write", formatted, owner);
  }

  return Object.freeze({
    warn,
    warnState,
    stats: (): NoticesSinkStats => Object.freeze({ dropped }),
  });
}
