import { SqliteConversationRepository } from "../conversation/index.js";
import type {
  CompactionResult,
  ConversationRepository,
  SessionSummary,
  StoredSession,
  TurnCommit,
  UsageCommit,
} from "../conversation/index.js";
import type { SessionRepository } from "../state/index.js";

/**
 * Wraps SessionRepository the same way SqliteConversationRepository does,
 * but stamps every created session with source:'orchestration' and the
 * given parent_session_id (contract L21) — by composition, not inheritance,
 * so src/conversation/sqlite-repository.ts (T08's shared file, which
 * hardcodes source:'cli' for the parent's own CLI sessions) never needs to
 * change. ConversationRuntime only ever calls createSession with the
 * standard {id, systemPrompt, model, cwd} shape, so the orchestration-
 * specific fields have to be supplied here, at construction time, rather
 * than threaded through per call.
 */
export class ChildConversationRepository implements ConversationRepository {
  // Concrete, not the ConversationRepository interface -- the three
  // compaction members below are unconditional on SqliteConversationRepository
  // (it always implements them), so typing this as the interface would make
  // every passthrough here deal with "maybe undefined" for no reason.
  private readonly delegate: SqliteConversationRepository;

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly parentSessionId: string,
  ) {
    this.delegate = new SqliteConversationRepository(sessions);
  }

  public createSession(input: {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly cwd: string;
  }): void {
    this.sessions.createSession({
      id: input.id,
      source: "orchestration",
      parentSessionId: this.parentSessionId,
      model: input.model,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
    });
  }

  public session(id: string): StoredSession | null {
    return this.delegate.session(id);
  }

  public loadMessages(id: string): readonly Readonly<Record<string, unknown>>[] {
    return this.delegate.loadMessages(id);
  }

  public commitTurn(commit: TurnCommit): void {
    this.delegate.commitTurn(commit);
  }

  public commitUsage(commit: UsageCommit): void {
    this.delegate.commitUsage(commit);
  }

  public summary(id: string): SessionSummary | null {
    return this.delegate.summary(id);
  }

  // Issue #252 round 2: without these three, ConversationRuntime's preflight
  // (attemptCompaction, src/conversation/compaction.ts) throws
  // CompactionUnsupportedError for every child session whose history
  // overflows the window -- a subagent turn (spawn_session/delegate_task,
  // child-runner.ts) would fault where the parent's own chat.ts route
  // compacts and continues. this.delegate is a concrete
  // SqliteConversationRepository, which always implements all three, so
  // these are plain passthroughs, same pattern as session/loadMessages/etc
  // above.
  public acquireCompressionLock(
    sessionId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): boolean {
    return this.delegate.acquireCompressionLock(sessionId, holder, now, ttlSeconds);
  }

  public releaseCompressionLock(sessionId: string, holder: string): boolean {
    return this.delegate.releaseCompressionLock(sessionId, holder);
  }

  public compactHistory(
    sessionId: string,
    holder: string,
    now: number,
    input: { readonly keepTailCount: number; readonly summary: string },
  ): CompactionResult {
    return this.delegate.compactHistory(sessionId, holder, now, input);
  }
}
