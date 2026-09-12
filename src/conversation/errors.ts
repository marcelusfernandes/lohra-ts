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
   * (no partial to estimate from). */
  public readonly partialUsage: Usage | null;
  public constructor(
    sessionId: string,
    cause?: unknown,
    options: { readonly partialUsage?: Usage | null; readonly apiCalls?: number } = {},
  ) {
    super("CONVERSATION_CANCELLED", "conversation cancelled", {
      sessionId,
      cause,
      apiCalls: options.apiCalls ?? 0,
    });
    this.partialUsage = options.partialUsage ?? null;
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
