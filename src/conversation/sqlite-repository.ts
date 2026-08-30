import type { CostEstimate } from "../pricing/index.js";
import { SessionRepository } from "../state/index.js";
import type { Usage } from "../transports/index.js";
import type {
  ConversationRepository,
  SessionSummary,
  StoredSession,
  TurnCommit,
  UsageCommit,
} from "./types.js";

function stringField(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`SESSION_FIELD_INVALID:${key}`);
  return value;
}

function usageIncrement(usage: Usage | null, cost: CostEstimate | null, apiCalls: number) {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    apiCalls,
    realUsd: cost?.usd ?? null,
    grossUsd: cost?.grossUsd ?? null,
  };
}

export class SqliteConversationRepository implements ConversationRepository {
  public constructor(private readonly sessions: SessionRepository) {}

  public createSession(input: {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly cwd: string;
  }): void {
    this.sessions.createSession({
      id: input.id,
      source: "cli",
      model: input.model,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
    });
  }

  public session(id: string): StoredSession | null {
    const row = this.sessions.getSession(id);
    if (row === null) return null;
    return {
      systemPrompt: stringField(row, "system_prompt"),
      model: stringField(row, "model"),
      cwd: stringField(row, "cwd"),
    };
  }

  public loadMessages(id: string): readonly Readonly<Record<string, unknown>>[] {
    return this.sessions.loadMessages(id);
  }

  public commitTurn(commit: TurnCommit): void {
    this.sessions.recordTurn(commit.sessionId, {
      user: {
        role: "user",
        content: typeof commit.user.content === "string" ? commit.user.content : "",
      },
      assistant: {
        role: "assistant",
        content: typeof commit.assistant.content === "string" ? commit.assistant.content : "",
        finishReason:
          typeof commit.assistant.finish_reason === "string"
            ? commit.assistant.finish_reason
            : null,
        reasoning:
          typeof commit.assistant.reasoning === "string" ? commit.assistant.reasoning : null,
      },
      usage: usageIncrement(commit.usage, commit.cost, commit.apiCalls),
    });
  }

  public commitUsage(commit: UsageCommit): void {
    const increment = usageIncrement(commit.usage, commit.cost, commit.apiCalls);
    if (increment !== null) this.sessions.addUsage(commit.sessionId, increment);
  }

  public summary(id: string): SessionSummary | null {
    return this.sessions.usage(id);
  }
}
