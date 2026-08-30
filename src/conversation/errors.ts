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
  public constructor(sessionId: string, limit: number) {
    super("MAX_ITERATIONS", `max_iterations (${String(limit)}) reached without a final response`, {
      sessionId,
    });
  }
}

export class ConversationCancelledError extends ConversationError {
  override readonly name = "ConversationCancelledError";
  public constructor(sessionId: string, cause?: unknown) {
    super("CONVERSATION_CANCELLED", "conversation cancelled", { sessionId, cause });
  }
}

export class ConversationTurnFailedError extends ConversationError {
  override readonly name = "ConversationTurnFailedError";
  public constructor(sessionId: string, message: string, cause: unknown) {
    super("MODEL_CALL_FAILED", message, { sessionId, apiCalls: 1, cause });
  }
}
import type { CostEstimate } from "../pricing/index.js";
import type { Usage } from "../transports/index.js";
import type { SessionSummary } from "./types.js";
