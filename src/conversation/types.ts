import type { CostEstimate } from "../pricing/index.js";
import type { NormalizedResponse, Usage } from "../transports/index.js";

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly model: string;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly tools: readonly Readonly<Record<string, unknown>>[];
  readonly signal: AbortSignal;
  // Provisional streaming seam (T12 gateway, disposable if T11 lands an
  // approved equivalent first -- see runtime.ts). Absent, never undefined,
  // when the caller didn't request streaming; adapters must not stream
  // just because this is set (see ModelTransport constructors' own
  // `streaming` flag).
  readonly onText?: (text: string) => void;
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
}

export type ConversationRuntimeEvent = Readonly<{
  type:
    | "turn.started"
    | "model.request.started"
    | "model.request.completed"
    | "turn.completed"
    | "turn.failed";
  sessionId: string;
  code?: string;
}>;

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
}

export interface ExecutedToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}
