/** CompletionService — run one stateless turn for the OpenAI endpoints.
 * Mirrors `lohra/server/service.py`: owns the shared transport/tool wiring,
 * builds a fresh ConversationRuntime per request (statelessness — assertions
 * 64/65/68), and maps the result to content/finish_reason/usage. Streaming is
 * the same path with a per-delta callback (contract v2 assertion 69: no
 * second loop — HTTP/SSE are adapters over the one ConversationRuntime). */

import { randomUUID } from "node:crypto";

import { ConversationRuntime, type ModelTransport, type ToolDispatcher } from "../conversation/index.js";
import { publicCauseMessage } from "../transports/index.js";
import { UpstreamError } from "./chat-format.js";
import { NonClosingTransport } from "./non-closing-transport.js";
import { RequestRepository } from "./request-repository.js";
import { estimateUsage, wireUsage, type OpenAiUsage } from "./usage.js";

export interface CompletionServiceDeps {
  readonly transport: ModelTransport;
  readonly systemPrompt: () => string;
  readonly provider: string;
  readonly maxIterations: number;
  readonly defaultMaxTokens: number;
  readonly toolDispatcher?: ToolDispatcher;
  readonly toolDefinitions?: readonly unknown[];
}

export interface RunTurnInput {
  readonly model: string;
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly userText: string;
  /** What to attribute as "prompt" when the provider reports no usage — the
   * client's raw array for chat, the already-parsed messages for Responses
   * (contract v2 assertion 62's base difference). */
  readonly usageMessages: readonly Readonly<Record<string, unknown>>[];
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly onDelta?: (delta: string) => void;
}

export interface CompletionResult {
  readonly model: string;
  readonly content: string;
  readonly finishReason: "stop" | "length";
  readonly usage: OpenAiUsage;
}

export class CompletionService {
  public constructor(private readonly deps: CompletionServiceDeps) {}

  public async run(input: RunTurnInput): Promise<CompletionResult> {
    const runtime = new ConversationRuntime({
      repository: new RequestRepository(input.history),
      transport: new NonClosingTransport(this.deps.transport),
      promptSnapshot: this.deps.systemPrompt,
      idSource: () => randomUUID(),
      clock: () => Date.now(),
      maxIterations: this.deps.maxIterations,
      maxTokens: input.maxTokens ?? this.deps.defaultMaxTokens,
      ...(this.deps.toolDispatcher ? { toolDispatcher: this.deps.toolDispatcher } : {}),
      ...(this.deps.toolDefinitions ? { toolDefinitions: this.deps.toolDefinitions } : {}),
    });

    let result;
    try {
      result = await runtime.runTurn({
        input: input.userText,
        provider: this.deps.provider,
        model: input.model,
        cwd: process.cwd(),
        temperature: input.temperature,
        ...(input.onDelta ? { onDelta: input.onDelta } : {}),
      });
    } catch (error) {
      throw new UpstreamError(publicCauseMessage(error));
    }

    const content = result.response.content ?? "";
    const finishReason = result.response.finishReason === "length" ? "length" : "stop";
    const usage = result.usageTotal !== null
      ? wireUsage(result.usageTotal)
      : estimateUsage(input.usageMessages, content);

    return { model: input.model, content, finishReason, usage };
  }
}
