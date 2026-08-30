import { estimateCost, type CostEstimate } from "../pricing/index.js";
import type { NormalizedResponse, ToolCall, Usage } from "../transports/index.js";
import { runBounded } from "../tools/dispatch.js";
import {
  ConversationCancelledError,
  ConversationError,
  ConversationTurnFailedError,
  IncompleteToolCallError,
  MaxIterationsError,
  MessageInjectionError,
  UnexpectedToolCallError,
} from "./errors.js";
import type {
  ConversationRepository,
  ConversationRuntimeEvent,
  ConversationTurnResult,
  ModelRequest,
  ModelTransport,
  ToolDispatcher,
} from "./types.js";

export interface ConversationRuntimeOptions {
  readonly repository: ConversationRepository;
  readonly transport: ModelTransport;
  readonly promptSnapshot: () => string;
  readonly toolDispatcher?: ToolDispatcher;
  readonly toolDefinitions?: readonly unknown[];
  readonly eventSink?: (event: ConversationRuntimeEvent) => void;
  readonly idSource: () => string;
  readonly clock: () => number;
  readonly maxIterations?: number;
  readonly maxTokens?: number | null;
  readonly pricingOverrides?: Parameters<typeof estimateCost>[1]["overrides"];
}

function immutableMessages(
  messages: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return structuredClone(messages);
}

function validToolCall(call: ToolCall): boolean {
  return call.name.length > 0 && call.arguments.length > 0;
}

function providerMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total;
  if (total === null) return { ...next };
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}

export class ConversationRuntime {
  private readonly maxIterations: number;
  private prompt: string | undefined;

  public constructor(private readonly options: ConversationRuntimeOptions) {
    this.maxIterations = Math.max(1, options.maxIterations ?? 128);
  }

  private promptSnapshot(): string {
    this.prompt ??= this.options.promptSnapshot();
    return this.prompt;
  }

  public async runTurn(input: {
    readonly input: string;
    readonly provider: string;
    readonly model: string;
    readonly cwd: string;
    readonly temperature?: number | null;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
    /** Drains zero or more messages to append at the top of every iteration
     * of this turn (the first included), before the next request is built —
     * an orchestration adapter's steer inbox is the intended caller. Absent
     * means no injection, and the turn behaves exactly as it did before this
     * option existed. A thrown error is wrapped in MessageInjectionError and
     * propagated (never swallowed, never left silent); no request is built
     * for that iteration. */
    readonly drainMessages?: () => readonly Readonly<Record<string, unknown>>[];
  }): Promise<ConversationTurnResult> {
    const sessionId = input.sessionId ?? this.options.idSource();
    let session = this.options.repository.session(sessionId);
    if (input.sessionId !== undefined && session === null) {
      throw new ConversationError("SESSION_NOT_FOUND", `session not found: ${sessionId}`, {
        sessionId,
      });
    }
    if (session === null) {
      const systemPrompt = this.promptSnapshot();
      this.options.repository.createSession({
        id: sessionId,
        systemPrompt,
        model: input.model,
        cwd: input.cwd,
      });
      session = { systemPrompt, model: input.model, cwd: input.cwd };
    } else {
      session = { ...session, systemPrompt: this.promptSnapshot() };
    }

    const signal = input.signal ?? new AbortController().signal;
    const history = immutableMessages(this.options.repository.loadMessages(sessionId));
    const messages: Readonly<Record<string, unknown>>[] = [
      ...history,
      { role: "user", content: input.input },
    ];
    const turnMessages: Readonly<Record<string, unknown>>[] = [
      { role: "user", content: input.input },
    ];
    const executedToolCalls: {
      id: string | null;
      name: string;
      arguments: string;
      result: string;
    }[] = [];
    const emit = (type: ConversationRuntimeEvent["type"], code?: string): void => {
      this.options.eventSink?.(
        Object.freeze({ type, sessionId, ...(code === undefined ? {} : { code }) }),
      );
    };
    emit("turn.started");
    let apiCalls = 0;
    let usageTotal: Usage | null = null;
    let reasoningTotal = "";
    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        if (signal.aborted) throw new ConversationCancelledError(sessionId, signal.reason);
        if (input.drainMessages !== undefined) {
          let injected: readonly Readonly<Record<string, unknown>>[];
          try {
            injected = input.drainMessages();
          } catch (error) {
            throw new MessageInjectionError(sessionId, error);
          }
          for (const injectedMessage of injected) {
            messages.push(injectedMessage);
            turnMessages.push(injectedMessage);
          }
        }
        const request: ModelRequest = {
          system: session.systemPrompt,
          messages: immutableMessages(messages),
          model: input.model,
          temperature: input.temperature ?? null,
          maxTokens: this.options.maxTokens ?? null,
          tools: immutableMessages(
            (this.options.toolDefinitions ?? []) as readonly Readonly<Record<string, unknown>>[],
          ),
          signal,
        };
        emit("model.request.started");
        let response: NormalizedResponse;
        try {
          response = await this.options.transport.complete(request);
        } catch (error) {
          if (signalAborted(signal)) throw new ConversationCancelledError(sessionId, error);
          throw new ConversationTurnFailedError(sessionId, providerMessage(error), error);
        }
        apiCalls += 1;
        usageTotal = addUsage(usageTotal, response.usage);
        if (response.reasoning !== null) reasoningTotal += response.reasoning;
        emit("model.request.completed");

        if (response.finishReason === "pause") {
          const assistantPauseMessage = {
            role: "assistant",
            content: response.content ?? "",
            finish_reason: response.finishReason,
            ...(response.reasoning === null ? {} : { reasoning: response.reasoning }),
            ...(response.providerData === null
              ? {}
              : { provider_data: structuredClone(response.providerData) }),
          } as const;
          messages.push(assistantPauseMessage);
          turnMessages.push(assistantPauseMessage);
          if (iteration >= this.maxIterations) {
            const cost = estimateCost(usageTotal, {
              provider: input.provider,
              model: input.model,
              ...(this.options.pricingOverrides === undefined
                ? {}
                : { overrides: this.options.pricingOverrides }),
            });
            if (usageTotal !== null)
              this.options.repository.commitUsage({ sessionId, usage: usageTotal, cost, apiCalls });
            throw new MaxIterationsError(
              sessionId,
              this.maxIterations,
              usageTotal,
              cost,
              this.options.repository.summary(sessionId),
              executedToolCalls,
              response.usage,
              "pause",
            );
          }
          continue;
        }

        if (response.finishReason === "tool_calls" || response.toolCalls.length > 0) {
          if (
            response.toolCalls.length === 0 ||
            response.toolCalls.some((call) => !validToolCall(call))
          ) {
            if (response.usage === null)
              throw new IncompleteToolCallError(sessionId, null, null, null);
            const cost = estimateCost(response.usage, {
              provider: input.provider,
              model: input.model,
              ...(this.options.pricingOverrides === undefined
                ? {}
                : { overrides: this.options.pricingOverrides }),
            });
            this.options.repository.commitUsage({
              sessionId,
              usage: response.usage,
              cost,
              apiCalls,
            });
            throw new IncompleteToolCallError(
              sessionId,
              response.usage,
              cost,
              this.options.repository.summary(sessionId),
            );
          }
          const toolDispatcher = this.options.toolDispatcher;
          if (toolDispatcher === undefined) throw new UnexpectedToolCallError(sessionId);
          const assistantToolMessage = {
            role: "assistant",
            content: response.content,
            finish_reason: response.finishReason,
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
            ...(response.reasoning === null ? {} : { reasoning: response.reasoning }),
            ...(response.providerData === null
              ? {}
              : { provider_data: structuredClone(response.providerData) }),
          } as const;
          messages.push(assistantToolMessage);
          turnMessages.push({ ...assistantToolMessage, content: response.content ?? "" });
          const toolMessages = await runBounded(response.toolCalls, 8, async (call) =>
            toolDispatcher.dispatch(call),
          );
          for (let index = 0; index < response.toolCalls.length; index += 1) {
            const call = response.toolCalls[index];
            const toolMessage = toolMessages[index];
            if (call === undefined || toolMessage === undefined) continue;
            messages.push(toolMessage);
            turnMessages.push(toolMessage);
            executedToolCalls.push({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
              result: typeof toolMessage.content === "string" ? toolMessage.content : "",
            });
          }
          if (iteration >= this.maxIterations) {
            const cost = estimateCost(usageTotal, {
              provider: input.provider,
              model: input.model,
              ...(this.options.pricingOverrides === undefined
                ? {}
                : { overrides: this.options.pricingOverrides }),
            });
            if (usageTotal !== null) {
              this.options.repository.commitUsage({
                sessionId,
                usage: usageTotal,
                cost,
                apiCalls,
              });
            }
            throw new MaxIterationsError(
              sessionId,
              this.maxIterations,
              usageTotal,
              cost,
              this.options.repository.summary(sessionId),
              executedToolCalls,
              response.usage,
              "tool_calls",
            );
          }
          continue;
        }

        const cost: CostEstimate | null = estimateCost(usageTotal, {
          provider: input.provider,
          model: input.model,
          ...(this.options.pricingOverrides === undefined
            ? {}
            : { overrides: this.options.pricingOverrides }),
        });
        const finalAssistant = {
          role: "assistant",
          content: response.content ?? "",
          finish_reason: response.finishReason,
          ...(response.reasoning === null ? {} : { reasoning: response.reasoning }),
          ...(response.providerData === null
            ? {}
            : { provider_data: structuredClone(response.providerData) }),
        } as const;
        turnMessages.push(finalAssistant);
        this.options.repository.commitTurn({
          sessionId,
          user: { role: "user", content: input.input },
          assistant: finalAssistant,
          messages: turnMessages,
          usage: usageTotal,
          cost,
          apiCalls,
        });
        emit("turn.completed");
        return {
          sessionId,
          input: input.input,
          model: input.model,
          temperature: input.temperature ?? null,
          response: {
            ...response,
            reasoning: reasoningTotal || null,
          },
          toolCalls: executedToolCalls,
          usageTotal,
          cost,
          apiCalls,
          sessionSummary: usageTotal === null ? null : this.options.repository.summary(sessionId),
        };
      }
      throw new MaxIterationsError(sessionId, this.maxIterations);
    } catch (error) {
      emit("turn.failed", error instanceof ConversationError ? error.code : "TURN_FAILED");
      throw error;
    } finally {
      await this.options.transport.close();
    }
  }
}
