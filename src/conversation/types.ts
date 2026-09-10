import type { CostEstimate } from "../pricing/index.js";
import type { NormalizedResponse, Usage } from "../transports/index.js";

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly model: string;
  readonly temperature: number | null;
  readonly effort: string | null;
  readonly maxTokens: number | null;
  readonly tools: readonly Readonly<Record<string, unknown>>[];
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
  readonly systemPrompt: string;
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
    readonly systemPrompt: string;
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
    | "compaction.unsupported";
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
}

export interface ExecutedToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}
