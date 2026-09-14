export class ConversationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly sessionId?: string;
      readonly apiCalls?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.sessionId = options.sessionId;
    this.apiCalls = options.apiCalls ?? 0;
  }

  public readonly sessionId: string | undefined;
  public readonly apiCalls: number;
}

export class UnexpectedToolCallError extends ConversationError {
  override readonly name = "UnexpectedToolCallError";
  public constructor(sessionId: string) {
    super("UNEXPECTED_TOOL_CALL", "provider returned tool_calls while tools are disabled", {
      sessionId,
      apiCalls: 1,
    });
  }
}

export class IncompleteToolCallError extends ConversationError {
  override readonly name = "IncompleteToolCallError";
  public constructor(
    sessionId: string,
    public readonly usage: Usage | null,
    public readonly cost: CostEstimate | null,
    public readonly sessionSummary: SessionSummary | null,
  ) {
    super("INCOMPLETE_TOOL_CALL", "provider returned incomplete tool_calls", {
      sessionId,
      apiCalls: 1,
    });
  }
}

export class MaxIterationsError extends ConversationError {
  override readonly name = "MaxIterationsError";
  public constructor(
    sessionId: string,
    limit: number,
    public readonly usage: Usage | null = null,
    public readonly cost: CostEstimate | null = null,
    public readonly sessionSummary: SessionSummary | null = null,
    public readonly toolCalls: readonly {
      readonly id: string | null;
      readonly name: string;
      readonly arguments: string;
      readonly result: string;
    }[] = [],
    public readonly lastUsage: Usage | null = null,
    public readonly stopReason: string = "tool_calls",
    /** Issue #594 (achado 1, residual de M21): mirrors `ConversationTurnResult
     * .partialCalls` (this same field's doc, `types.ts`) — how many of THIS
     * turn's own calls were torn down by a steer-driven interrupt and
     * absorbed with `continue` before the cap was hit, regardless of which
     * iteration's `stopReason` finally threw. `usage` above already includes
     * every one of those calls' own ESTIMATED spend (`estimatePartialUsage`,
     * folded in per-call by `runtime.ts` before this ever throws); `0` means
     * every call this turn actually made completed for real (a genuine
     * cap-hit after real, completed iterations, `child-runner.ts`'s own
     * consumer). Deriving `partial`/`usageUncertain` from THIS field instead
     * of `stopReason === "interrupted"` alone fixes a false negative: a
     * steer absorbed on an EARLIER iteration whose cap is hit by a LATER,
     * normally-completed one (`stopReason: "pause"`/`"tool_calls"`) used to
     * report a silently "fully measured" usage that in fact still carried an
     * estimate. */
    public readonly partialCalls: number = 0,
  ) {
    super("MAX_ITERATIONS", `max_iterations (${String(limit)}) reached without a final response`, {
      sessionId,
      apiCalls: limit,
    });
  }
}

export class ConversationCancelledError extends ConversationError {
  override readonly name = "ConversationCancelledError";
  /** Issue #518 (M16-S3, ADR 0005): non-null only when the loop's own
   * `isAbortOf` (`runtime.ts`) recognized a genuine in-flight stream abort
   * (`StreamAbortedError`) — estimated from whatever partial text/usage the
   * transport had already shown for itself (`estimatePartialUsage`,
   * `context/token-estimate.ts`), never a real measurement. `null` for a
   * pre-issuance cancellation (the call was never made) and for an abort
   * that consumed the signal without going through `StreamAbortedError`
   * (no partial to estimate from). Issue #568 (r2, veredito da PR #573):
   * kept to EXACTLY this one call's own estimate, deliberately never
   * combined with `measuredUsage` below — `child-runner.ts` derives
   * `partial`/`partial_leaves` from `partialUsage !== null` alone
   * (`core.ts`/`workflow/runtime.ts`/`builtin-definitions.ts`: a leaf only
   * counts as partial when its usage includes an ESTIMATED portion), so
   * merging real measurement in here would silently mark a leaf partial
   * with zero tokens ever estimated. */
  public readonly partialUsage: Usage | null;
  /** Issue #568 (r2, veredito da PR #573): the turn's usage (`usageTotal`,
   * `runtime.ts`) accumulated BEFORE the one call this error is about got
   * torn down — real, provider-measured usage from every earlier iteration
   * of a multi-iteration turn (a tool-call/pause loop) that completed
   * normally, EXCEPT that a steer-driven interrupt absorbed mid-turn
   * (#520) also folds its own ESTIMATE into this same `usageTotal` before
   * this cancel ever throws (`runtime.ts:541-547`, `estimatePartialUsage`)
   * — so this field is not exhaustively "real measurement" the moment a
   * turn mixes both triggers. A THIRD, real source (issue #569): this same
   * iteration's own preflight compaction can already have summarized the
   * history through its own provider call (`summarize`, `runtime.ts:406-
   * 411`, `addUsage` at `:411`, reachable from iteration 1 via
   * `preflightCompact` at `:436`) — BEFORE that iteration's own request is
   * ever built, so `usageTotal` is not necessarily still whatever an
   * earlier ITERATION alone would suggest. `partial` still derives from `partialUsage`
   * alone (see that field's own doc), never from whether THIS field
   * happens to include an estimated portion.
   *
   * `null` in exactly two cases, never zero-filled (same "never measured"
   * convention `partialUsage`/`usageUncertain` already use): a
   * PRE-ISSUANCE cancel (the signal was already aborted before this call's
   * own request was ever built, `runtime.ts:423`/`:459`) — constructed
   * with no `measuredUsage` option at all, REGARDLESS of whatever
   * `usageTotal` an earlier iteration of the SAME turn may already carry;
   * or a turn where no earlier iteration (real or steer-estimated) ever
   * measured any usage AND this iteration's own preflight compaction never
   * ran either — a "single-call turn" is only guaranteed `null` here when
   * BOTH are true. A SEPARATE field from `partialUsage` on
   * purpose (see that field's own doc): `child-runner.ts` is the one
   * reader, and combines the two into the leaf's reported `usage` while
   * still deriving `partial` from `partialUsage` alone. */
  public readonly measuredUsage: Usage | null;
  /** Issue #650 (item 12, follow-up do veredito da PR #627): mirrors
   * `MaxIterationsError.partialCalls` (issue #594) — how many of THIS
   * turn's own calls were torn down by a steer-driven interrupt and
   * absorbed with `continue` (`runtime.ts`'s own `partialCalls` counter)
   * BEFORE this in-flight external cancel threw (`runtime.ts:513-527`,
   * the only constructor call site that passes this option). The two
   * pre-issuance throws (`runtime.ts:423`,`:459`) stay at the constructor
   * default `0` on purpose — no call belonging to THIS iteration was ever
   * issued at all, so nothing from it could have been absorbed. `0` also
   * covers every turn that never had a steer absorbed at all — same
   * "genuine, fully-accounted cancel" meaning `MaxIterationsError`'s own
   * `partialCalls === 0` already carries. `child-runner.ts` is unchanged
   * by this: `partial`/`usageUncertain` there still derive from
   * `partialUsage !== null` alone (see that field's own doc) — this field
   * is additional data for a caller that wants to tell "cancel after some
   * steer-torn-down calls were already absorbed this turn" apart from
   * "cancel before any of that happened" — correção de atribuição na #670
   * (veredito PR #656): the count is calls torn down and absorbed with
   * `continue` (`runtime.ts:544`), never `apiCalls` (real, completed
   * calls) — not a new input to the existing `partial`/`usageUncertain`
   * contract. */
  public readonly partialCalls: number;
  public constructor(
    sessionId: string,
    cause?: unknown,
    options: {
      readonly partialUsage?: Usage | null;
      readonly measuredUsage?: Usage | null;
      readonly apiCalls?: number;
      readonly partialCalls?: number;
    } = {},
  ) {
    super("CONVERSATION_CANCELLED", "conversation cancelled", {
      sessionId,
      cause,
      apiCalls: options.apiCalls ?? 0,
    });
    this.partialUsage = options.partialUsage ?? null;
    this.measuredUsage = options.measuredUsage ?? null;
    this.partialCalls = options.partialCalls ?? 0;
  }
}

export class ConversationTurnFailedError extends ConversationError {
  override readonly name = "ConversationTurnFailedError";
  public constructor(sessionId: string, message: string, cause: unknown) {
    super("MODEL_CALL_FAILED", message, { sessionId, apiCalls: 1, cause });
  }
}

export class MessageInjectionError extends ConversationError {
  override readonly name = "MessageInjectionError";
  public constructor(sessionId: string, cause: unknown) {
    super("MESSAGE_INJECTION_FAILED", "drainMessages threw before the request was built", {
      sessionId,
      cause,
    });
  }
}

// Compaction preflight (issue #252, epic #230). The latch: a turn attempts
// compaction at most once. `afterCompaction === true` means the estimate
// still exceeds the window right after a compaction just ran (compaction
// was futile) OR a second overflow was detected later in the same turn
// (the latch refuses to compact again) -- either way, no second attempt.
export class ContextWindowExceededError extends ConversationError {
  override readonly name = "ContextWindowExceededError";
  public constructor(
    sessionId: string,
    public readonly estimatedTokens: number,
    public readonly windowTokens: number,
    public readonly windowSource: string,
    public readonly afterCompaction: boolean,
  ) {
    super(
      "CONTEXT_WINDOW_EXCEEDED",
      `estimated ${String(estimatedTokens)} tokens ${afterCompaction ? "still " : ""}exceed the ${String(windowTokens)}-token window (source: ${windowSource})`,
      { sessionId },
    );
  }
}

export class CompressionLockBusyError extends ConversationError {
  override readonly name = "CompressionLockBusyError";
  public constructor(sessionId: string) {
    super("COMPRESSION_LOCK_BUSY", "compression lock held by another process", { sessionId });
  }
}

// SessionRepository.compactHistory (src/state/session-repository.ts) checks
// the lock inside its own write transaction and throws a raw
// `Error("COMPRESSION_LOCK_NOT_HELD:...")` when `holder` doesn't hold it
// anymore -- a real TOCTOU window: attemptCompaction's own acquire and this
// use are a few lines apart, never atomic with each other, so the lock can
// legitimately expire or move to another process in between. Distinct from
// CompressionLockBusyError (never acquired the lock at all, after bounded
// retries): this is losing a lock already held. attemptCompaction
// (src/conversation/compaction.ts) wraps the raw throw into this so it
// carries a real `code` instead of falling through runTurn's `error
// instanceof ConversationError ? error.code : "TURN_FAILED"` as a generic
// failure (issue #287).
export class CompressionLockNotHeldError extends ConversationError {
  override readonly name = "CompressionLockNotHeldError";
  public constructor(sessionId: string, cause: unknown) {
    super("COMPRESSION_LOCK_NOT_HELD", "compression lock not held by this holder", {
      sessionId,
      cause,
    });
  }
}

export class CompactionFailedError extends ConversationError {
  override readonly name = "CompactionFailedError";
  public constructor(sessionId: string, cause: unknown) {
    super("COMPACTION_FAILED", "summarizing the history for compaction failed", {
      sessionId,
      cause,
    });
  }
}

export class CompactionUnsupportedError extends ConversationError {
  override readonly name = "CompactionUnsupportedError";
  public constructor(sessionId: string) {
    super("COMPACTION_UNSUPPORTED", "this repository does not support compaction", { sessionId });
  }
}
import type { CostEstimate } from "../pricing/index.js";
import type { Usage } from "../transports/index.js";
import type { SessionSummary } from "./types.js";
