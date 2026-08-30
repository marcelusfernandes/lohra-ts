/** A stateless, per-request `ConversationRepository`: seeded once with the
 * client-supplied history, discards every write. Statelessness (contract v2
 * assertions 64/65/68) comes from constructing a fresh instance per request —
 * this is the TS analog of the oracle's fresh `Agent` per request. */

import type {
  ConversationRepository,
  SessionSummary,
  StoredSession,
  TurnCommit,
  UsageCommit,
} from "../conversation/index.js";

export class RequestRepository implements ConversationRepository {
  public constructor(
    private readonly history: readonly Readonly<Record<string, unknown>>[],
  ) {}

  public createSession(_input: {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly cwd: string;
  }): void {
    // No session ever persists past this request.
  }

  public session(_id: string): StoredSession | null {
    return null;
  }

  public loadMessages(_id: string): readonly Readonly<Record<string, unknown>>[] {
    return structuredClone(this.history);
  }

  public commitTurn(_commit: TurnCommit): void {
    // Discarded: nothing survives the request.
  }

  public commitUsage(_commit: UsageCommit): void {
    // Discarded: nothing survives the request.
  }

  public summary(_id: string): SessionSummary | null {
    return null;
  }
}
