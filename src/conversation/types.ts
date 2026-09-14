import type { CostEstimate } from "../pricing/index.js";
import type { NormalizedResponse, SystemBands, Usage } from "../transports/index.js";

export interface ModelRequest {
  /** Issue #586 (épico #575): a plain string (every caller before this
   * issue) is the whole prompt with no cache boundary; the three-band form
   * lets a transport that understands it (`anthropic-messages.ts`) mark a
   * breakpoint after `stable`+`context`. Passed straight through by
   * `provider-model.ts`/`chat-completions-model.ts` to their own
   * `BuildKwargsOptions.system` (same union there) -- neither needed
   * editing for this widening. */
  readonly system: string | SystemBands;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly model: string;
  readonly temperature: number | null;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly tools: readonly Readonly<Record<string, unknown>>[];
  /** Issue #578: forces the model to call the named tool — threaded
   * straight into each adapter's own `BuildKwargsOptions.toolChoice`
   * (`transports/types.ts`, already implemented per-provider:
   * `chat-completions.ts`/`anthropic-messages.ts`/`responses.ts`). `null`/
   * absent means no forcing, same as every request before this issue. */
  readonly toolChoice?: string | null;
  readonly signal: AbortSignal;
  /** Per-call text-delta sink; present only when the caller wants streaming. */
  readonly onText?: (delta: string) => void;
}

export interface ModelTransport {
  complete(request: ModelRequest): Promise<NormalizedResponse>;
  close(): void | Promise<void>;
}

export interface ToolDispatcher {
  dispatch(call: {
    readonly id: string | null;
    readonly name: string;
    readonly arguments: string;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface StoredSession {
  /** Issue #586 (2ª rodada): widened the same way as `ModelRequest.system`
   * above -- `SqliteConversationRepository.session()`
   * (`src/conversation/sqlite-repository.ts`, out of this issue's `Files`)
   * reads `systemPromptBands(id)` and returns `SystemBands` for every
   * session (migration-tolerant: a row from before this issue, only
   * `system_prompt`, comes back with the whole flattened text as
   * `stable`, `context`/`volatile` empty -- never the plain-string member
   * of this union). `ConversationRuntime.runTurn` (`runtime.ts:365`, out of
   * this issue's `Files`) discards these restored bands before building
   * the next request of a RESUMED session, replacing them with a fresh
   * `this.promptSnapshot()` call -- the limit that leaves open, documented
   * in `docs/system-prompt.md`, is that cache reuse across processes
   * depends on `promptSnapshot()` reconstructing `stable`+`context`
   * byte-identically (the only bands before the Anthropic breakpoint --
   * `volatile` changing never invalidates the cache). */
  readonly systemPrompt: string | SystemBands;
  readonly model: string;
  readonly cwd: string;
}

export interface TurnCommit {
  readonly sessionId: string;
  readonly user: Readonly<Record<string, unknown>>;
  readonly assistant: Readonly<Record<string, unknown>>;
  readonly messages?: readonly Readonly<Record<string, unknown>>[];
  readonly usage: Usage | null;
  readonly cost: CostEstimate | null;
  readonly apiCalls: number;
}

export interface UsageCommit {
  readonly sessionId: string;
  readonly usage: Usage;
  readonly cost: CostEstimate | null;
  readonly apiCalls: number;
}

export interface SessionSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly apiCallCount: number;
  readonly pricedCallCount: number | null;
  readonly actualCostUsd: number | null;
  readonly estimatedCostUsd: number | null;
}

/** Result of a compaction rewrite (issue #252): how many of the active
 * messages read before the rewrite were folded into the summary versus
 * kept verbatim. `summarizedCount === 0` means there was nothing left to
 * fold (the futile case a caller must treat as "compaction can't help"). */
export interface CompactionResult {
  readonly summarizedCount: number;
  readonly keptCount: number;
}

export interface ConversationRepository {
  createSession(input: {
    readonly id: string;
    /** Issue #586 (2ª rodada): widened alongside `StoredSession.systemPrompt`
     * above so `SqliteConversationRepository.createSession` (in this issue's
     * Files now) can persist the bands, not just the flattened text. Every
     * OTHER implementer (`ChildConversationRepository`, `RequestRepository`,
     * out of Files) keeps its own narrower `systemPrompt: string` method
     * signature unchanged — method bivariance lets that satisfy this wider
     * interface member without any edit there. */
    readonly systemPrompt: string | SystemBands;
    readonly model: string;
    readonly cwd: string;
  }): void;
  session(id: string): StoredSession | null;
  loadMessages(id: string): readonly Readonly<Record<string, unknown>>[];
  commitTurn(commit: TurnCommit): void;
  commitUsage(commit: UsageCommit): void;
  summary(id: string): SessionSummary | null;
  // Optional compaction capability (issue #252). SqliteConversationRepository
  // and ChildConversationRepository (src/orchestration/child-repository.ts)
  // implement all three -- both back onto a real, lockable SessionRepository.
  // A repository with nothing to persist past the call (RequestRepository,
  // src/server/service.ts -- a fresh instance per stateless HTTP request,
  // no session row, nothing to lock or rewrite) legitimately implements
  // none of the three: ConversationRuntime's preflight fails OPEN for it
  // (warns via `"compaction.unsupported"`, sends the request as it would
  // have before #252 existed) rather than faulting invariant 2 the other
  // way -- a repository that never claimed this capability isn't a silent
  // failure to compact, it's simply out of scope for it.
  acquireCompressionLock?(
    sessionId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): boolean;
  releaseCompressionLock?(sessionId: string, holder: string): boolean;
  compactHistory?(
    sessionId: string,
    holder: string,
    now: number,
    input: { readonly keepTailCount: number; readonly summary: string },
  ): CompactionResult;
}

export type ConversationRuntimeEvent = Readonly<{
  type:
    | "turn.started"
    | "model.request.started"
    | "model.request.completed"
    | "turn.completed"
    | "turn.failed"
    | "session.compacted"
    /** Preflight found the estimate over threshold but `repository` has
     * none of the three compaction members -- fail-open (issue #252 round
     * 2): the turn proceeds with the oversized request exactly like it
     * would have before #252 existed, `code` is always
     * `"COMPACTION_UNSUPPORTED"`. Never a fault -- see the comment on
     * `ConversationRepository`'s compaction members above. */
    | "compaction.unsupported"
    /** Issue #587 acréscimo item 3: fires when `attemptCompaction`'s
     * `buildTranscript` (compaction.ts) had to cut the folded prefix handed
     * to the summarizer to fit its token budget -- the ONE consumer of
     * `CompactionAttemptResult.transcriptTruncated`, which had none before
     * this issue. Never a fault (invariant 2 is about SILENT loss, and the
     * summary itself still gets produced from what's left). */
    | "compaction.transcript_truncated"
    /** Issue #587 acréscimo item 4 / AC: the injected `options.summarize`
     * (an `AuxClient`'s, normally) threw -- the turn fell open to the
     * default summarizer (this turn's own transport/model) via
     * `summarizeWithFallback` (`src/agent/aux.ts`) instead of failing.
     * Fail-open, never silent: `code` carries the failure's constructor
     * name, same convention as `model.request.interrupted` below. */
    | "compaction.aux_fallback"
    /** Issue #520 (M16-S5, ADR 0005): a call already in flight was torn
     * down by a steer-driven interrupt (`interruptSource`, `runTurn`'s own
     * option) rather than by `signal` itself -- the turn absorbs this with
     * `continue`, never `turn.failed`, so this is the only per-call trace
     * of an interrupted request that a completed turn leaves. Fires once
     * per interrupted call, immediately before that iteration's `continue`. */
    | "model.request.interrupted";
  sessionId: string;
  code?: string;
  /** Present only on `session.compacted` events (issue #252). */
  compaction?: Readonly<{
    summarizedCount: number;
    keptCount: number;
    estimateBefore: number;
    estimateAfter: number;
  }>;
}>;

/** Surfaced on `ConversationTurnResult` (and, through it, `successEnvelope`)
 * only when a compaction actually ran during the turn; `null`/absent
 * otherwise -- existing envelope fixtures that never pass this field keep
 * their exact key count (issue #252, keeps `tests/conversation-envelope.test.ts`
 * unchanged). */
export interface CompactionSummary {
  readonly summarizedCount: number;
  readonly keptCount: number;
  readonly estimateBefore: number;
  readonly estimateAfter: number;
}

export interface ConversationTurnResult {
  readonly sessionId: string;
  readonly input: string;
  readonly model: string;
  readonly temperature: number | null;
  readonly response: NormalizedResponse;
  readonly toolCalls?: readonly ExecutedToolCall[];
  readonly usageTotal: Usage | null;
  readonly cost: CostEstimate | null;
  readonly apiCalls: number;
  readonly sessionSummary: SessionSummary | null;
  readonly compaction?: CompactionSummary | null;
  /** Issue #520 (M16-S5, ADR 0005): how many of this turn's own provider
   * calls were torn down by a steer-driven interrupt and absorbed with
   * `continue` -- present only when at least one was (never `0`, keeping
   * every `ConversationTurnResult` fixture from before this issue
   * byte-identical). `usageTotal` above already includes each one's
   * ESTIMATED partial spend (`estimatePartialUsage`); this is only the
   * COUNT, for `createChildRunner` (D3) to mark the resulting
   * `CollectResult` `partial`/`usageUncertain` even though the turn itself
   * completed normally. */
  readonly partialCalls?: number;
}

export interface ExecutedToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}

/** Issue #589: structural port `runTurn` calls at the start/end/failure of a
 * turn to deliver pending `operator_notices` without a tool call. The real
 * implementation (`createTurnNoticesPort`, `src/context/notices-overlay.ts`)
 * fails open on every method — `runtime.ts` never faults a turn because the
 * notices store had a problem. Absent (every caller before this issue, and
 * most tests) means the turn is byte-identical to before #589 existed. */
export interface TurnNoticesClaim {
  readonly token: readonly number[];
  readonly overlay: string | null;
}

export interface TurnNoticesPort {
  claim(sessionId: string): TurnNoticesClaim;
  ack(token: readonly number[]): void;
  publishFailure(sessionId: string, code: string, cause: unknown): void;
}
