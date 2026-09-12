export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "pause";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export interface ToolCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: string;
  readonly providerData: Readonly<Record<string, unknown>> | null;
}

export interface NormalizedResponse {
  readonly content: string | null;
  readonly finishReason: FinishReason;
  readonly toolCalls: readonly ToolCall[];
  readonly reasoning: string | null;
  readonly usage: Usage | null;
  readonly providerData: Readonly<Record<string, unknown>> | null;
}

export interface BuildKwargsOptions {
  readonly model: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly system?: string | null;
  readonly tools?: readonly Readonly<Record<string, unknown>>[] | null;
  readonly maxTokens?: number | null;
  readonly temperature?: number | null;
  readonly toolChoice?: string | null;
  readonly effort?: string | null;
}

export type ChatKwargs = Readonly<Record<string, unknown>>;

export interface StreamCallbacks {
  readonly onText?: (text: string) => void;
  readonly onReasoning?: (text: string) => void;
  readonly onWarning?: (message: string) => void;
}

/** What a stream aborted in flight (ADR 0005) already had to show for
 * itself: `text` is the concatenation of the text deltas already replayed
 * through `onText` before the tear-down; `usage` is only non-null when a
 * usage-bearing frame reached the client before the abort (today, only
 * Anthropic's `message_start` — Chat Completions and Responses always
 * carry usage in their terminal frame, which an in-flight abort never
 * reaches). `reasoningChars`/`toolArgumentChars` are lengths, not the text
 * itself — the raw reasoning/tool-argument text isn't replayed anywhere a
 * caller can already observe it mid-stream. */
export interface PartialStream {
  readonly text: string;
  readonly reasoningChars: number;
  readonly toolArgumentChars: number;
  readonly usage: Usage | null;
}

export interface HttpResponseData {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface ChatHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface ChatHttpPort {
  post(request: ChatHttpRequest): Promise<HttpResponseData>;
  close?(): void | Promise<void>;
}
