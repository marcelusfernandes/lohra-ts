import { SqliteConversationRepository } from "../conversation/index.js";
import type {
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
  private readonly delegate: ConversationRepository;

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
}
