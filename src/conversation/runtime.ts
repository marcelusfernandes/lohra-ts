import { randomUUID } from "node:crypto";

import { estimateCost, type CostEstimate } from "../pricing/index.js";
import { estimatePartialUsage, estimateRequestTokens } from "../context/token-estimate.js";
import { emptyPartialStream, StreamAbortedError } from "../transports/index.js";
import type { NormalizedResponse, ToolCall, Usage } from "../transports/index.js";
import { runBounded } from "../tools/dispatch.js";
import {
  attemptCompaction,
  buildSummaryRequest,
  compactionThreshold,
  resolveTurnContextWindow,
  DEFAULT_LOCK_RETRIES,
  DEFAULT_LOCK_RETRY_DELAY_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_MIN_KEEP_MESSAGES,
} from "./compaction.js";
import {
  ConversationCancelledError,
  ConversationError,
  ConversationTurnFailedError,
  ContextWindowExceededError,
  IncompleteToolCallError,
  MaxIterationsError,
  MessageInjectionError,
  UnexpectedToolCallError,
} from "./errors.js";
import type {
  CompactionSummary,
  ConversationRepository,
  ConversationRuntimeEvent,
  ConversationTurnResult,
  ModelRequest,
  ModelTransport,
  StoredSession,
  ToolDispatcher,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Reading `.aborted` through a call, rather than as a bare property access,
// keeps TS's control-flow narrowing from folding a SECOND check in the same
// iteration to a static `false` (it cannot see that an external
// `controller.abort()` can flip the getter between the two checks, across
// the `await this.preflightCompact(...)` gap issue #252 introduced) —
// without this, `@typescript-eslint/no-unnecessary-condition` flags the
// second check as dead code, which it is not.
function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Issue #518 (M16-S3, ADR 0005): narrow, deliberately NOT "any failure while
 * aborted" — a genuine 5xx/route fault that happens to arrive after the
 * signal already fired is still a real provider failure (contra-assertion,
 * `tests/conversation-runtime.test.ts`), never reclassified into a
 * cancellation. Recognizes exactly the shapes an in-flight abort can throw
 * (round-1 review on PR #524, S1): a genuine `StreamAbortedError` (the
 * native `NativeChatHttpPort` path, always this shape); a raw `AbortError`
 * (the fetcher path's `AbortController`-driven rejection, standard DOM
 * naming); or an error whose own `.cause` IS the signal's abort reason
 * (a caller-supplied reason surfacing crude through an intermediate wrapper
 * before `StreamAbortedError` ever gets constructed — the fetcher path's
 * OTHER shape, when the signal was already aborted before `post()` ran).
 * `signalAborted(signal)` gates all three: none of these shapes proves an
 * abort on their OWN (an "AbortError" name or a coincidental `.cause` could,
 * in principle, come from somewhere else), the signal's own state is the
 * one fact this function trusts.
 */
function isAbortOf(error: unknown, signal: AbortSignal): boolean {
  if (!signalAborted(signal)) return false;
  if (error instanceof StreamAbortedError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.cause === signal.reason;
}

/** Issue #520 (M16-S5, ADR 0005): the abort REASON `interruptSource`'s armed
 * hook passes to its own per-call `AbortController` — never thrown, never
 * surfaced to a caller; only ever read back through `call.signal.aborted`
 * below to tell a steer-driven interrupt apart from the outer `signal`'s
 * own external cancel (which keeps taking precedence, S3). Named so a
 * future debugging session reading a rejection's `.cause` chain sees WHY
 * that particular call tore down, without this ever needing to be exported. */
class SteerInterrupt extends Error {
  override readonly name = "SteerInterrupt";
}

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
  /** Compaction preflight (issue #252). Every field below has a default
   * that makes compaction work out of the box for any caller that already
   * constructs a ConversationRuntime — none of them need to change to get
   * it (`commands/chat.ts` in particular; see `src/conversation/compaction.ts`). */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Overrides the default summarizer (a call to this runtime's own
   * `transport` with `SUMMARY_SYSTEM`, `src/agent/aux.ts`). Injection point
   * for a future `AuxClient.summarizer()` wiring — see `compaction.ts`. */
  readonly summarize?: (transcript: string) => Promise<string>;
  readonly compactionHolder?: string;
  readonly minKeepMessages?: number;
  readonly lockTtlSeconds?: number;
  readonly lockRetries?: number;
  readonly lockRetryDelayMs?: number;
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
  // Identifies THIS runtime instance as a compression_locks holder (issue
  // #252) — stable for the lifetime of the instance, so a retry against the
  // same lock row after a transient failure is recognizable as the same
  // owner. One per process in every real caller (chat.ts constructs one
  // ConversationRuntime per invocation), which is exactly what invariant 4
  // (cross-process writes under lease/fence) needs.
  private readonly compactionHolder: string;
  private readonly minKeepMessages: number;
  private readonly lockTtlSeconds: number;
  private readonly lockRetries: number;
  private readonly lockRetryDelayMs: number;

  public constructor(private readonly options: ConversationRuntimeOptions) {
    this.maxIterations = Math.max(1, options.maxIterations ?? 128);
    this.compactionHolder = options.compactionHolder ?? randomUUID();
    this.minKeepMessages = Math.max(0, options.minKeepMessages ?? DEFAULT_MIN_KEEP_MESSAGES);
    this.lockTtlSeconds = Math.max(1, options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS);
    this.lockRetries = Math.max(1, options.lockRetries ?? DEFAULT_LOCK_RETRIES);
    this.lockRetryDelayMs = Math.max(0, options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS);
  }

  private promptSnapshot(): string {
    this.prompt ??= this.options.promptSnapshot();
    return this.prompt;
  }

  /**
   * Preflight compaction (issue #252): estimates what the next model call
   * would cost in tokens (history + this turn so far + system + tools —
   * the reviewer notes on PR #267/#270 are why system/tools are included
   * here even though `estimateTokens` alone only sees `messages`) and, if
   * it would overflow the resolved context window, compacts the
   * *persisted* history under the session's `compression_locks` row.
   *
   * Mutates `messages` in place (splices the old history prefix for a
   * fresh, shorter one) when it compacts — same imperative-accumulator
   * style `runTurn` already uses for `messages`/`turnMessages` elsewhere in
   * this file, not a broken immutability rule: this is a turn-scoped
   * working array, never shared state.
   *
   * Returns `null` when the current estimate already fits (the fast path:
   * no lock, no I/O) OR when `repository` has no compaction capability at
   * all (fail-open, issue #252 round 2 — see the comment on
   * `ConversationRepository`'s compaction members, `src/conversation/types.ts`
   * — emits `"compaction.unsupported"` first so the miss is observable,
   * then sends the oversized request exactly like before #252 existed;
   * `RequestRepository`, `src/server/service.ts`, is the real caller this
   * protects — a fresh stateless instance per HTTP request has no session
   * to lock or rewrite). Throws `ContextWindowExceededError` — the latch —
   * when `repository` DOES support compaction and: the turn already
   * compacted once and still doesn't fit; nothing was left in the
   * persisted history to fold (compaction would be futile); or a
   * compaction just ran and the *new* estimate still doesn't fit. There is
   * never a second compaction attempt within one turn.
   */
  private async preflightCompact(context: {
    readonly sessionId: string;
    readonly session: StoredSession;
    readonly provider: string;
    readonly model: string;
    readonly messages: Readonly<Record<string, unknown>>[];
    readonly historyBoundary: number;
    readonly compactedThisTurn: boolean;
    readonly summarize: (transcript: string) => Promise<string>;
    readonly emit: (
      type: ConversationRuntimeEvent["type"],
      code?: string,
      compaction?: ConversationRuntimeEvent["compaction"],
    ) => void;
  }): Promise<{ readonly newHistoryBoundary: number; readonly summary: CompactionSummary } | null> {
    const environment = this.options.environment ?? process.env;
    const tools = (this.options.toolDefinitions ?? []) as readonly Readonly<
      Record<string, unknown>
    >[];
    const resolution = resolveTurnContextWindow({
      provider: context.provider,
      model: context.model,
      environment,
    });
    const threshold = compactionThreshold({
      window: resolution.tokens,
      source: resolution.source,
      maxTokens: this.options.maxTokens ?? 0,
    });
    const estimateBefore = estimateRequestTokens({
      system: context.session.systemPrompt,
      messages: context.messages,
      tools,
    }).tokens;
    if (estimateBefore <= threshold) return null;

    const repository = this.options.repository;
    if (
      repository.acquireCompressionLock === undefined ||
      repository.releaseCompressionLock === undefined ||
      repository.compactHistory === undefined
    ) {
      context.emit("compaction.unsupported", "COMPACTION_UNSUPPORTED");
      return null;
    }

    if (context.compactedThisTurn) {
      throw new ContextWindowExceededError(
        context.sessionId,
        estimateBefore,
        resolution.tokens,
        resolution.source,
        true,
      );
    }

    const outcome = await attemptCompaction({
      repository: this.options.repository,
      summarize: context.summarize,
      sessionId: context.sessionId,
      holder: this.compactionHolder,
      now: this.options.clock(),
      lockTtlSeconds: this.lockTtlSeconds,
      lockRetries: this.lockRetries,
      lockRetryDelayMs: this.lockRetryDelayMs,
      sleep,
      minKeepMessages: this.minKeepMessages,
    });

    if (!outcome.compacted) {
      throw new ContextWindowExceededError(
        context.sessionId,
        estimateBefore,
        resolution.tokens,
        resolution.source,
        false,
      );
    }

    context.messages.splice(0, context.historyBoundary, ...outcome.history);
    const estimateAfter = estimateRequestTokens({
      system: context.session.systemPrompt,
      messages: context.messages,
      tools,
    }).tokens;
    if (estimateAfter > threshold) {
      throw new ContextWindowExceededError(
        context.sessionId,
        estimateAfter,
        resolution.tokens,
        resolution.source,
        true,
      );
    }

    return {
      newHistoryBoundary: outcome.history.length,
      summary: {
        summarizedCount: outcome.summarizedCount,
        keptCount: outcome.keptCount,
        estimateBefore,
        estimateAfter,
      },
    };
  }

  public async runTurn(input: {
    readonly input: string;
    readonly provider: string;
    readonly model: string;
    readonly cwd: string;
    readonly temperature?: number | null;
    /** contract L1/L9 (T13): only ever set for a child's turn via
     * spawn_session/delegate_task's own `effort` override — the parent's
     * own chat command has no surface to set this at all (the oracle's
     * cli.py has no effort flag either), so this stays absent/null there
     * and nothing changes for the parent's own requests. */
    readonly effort?: string | null;
    readonly sessionId?: string;
    /** Issue #518 (ADR 0005): checked cooperatively between iterations
     * (`signalAborted`, before each provider call is even issued) AND
     * consulted after a call already in flight rejects (`isAbortOf`, in the
     * `catch` around `transport.complete`) — an abort the transport itself
     * observed mid-stream now surfaces as `ConversationCancelledError` with
     * whatever partial usage it could estimate, not as a generic turn
     * failure. The default summarizer (compaction's own call,
     * `buildSummaryRequest` above) forwards this SAME signal, so a
     * compaction summary call in flight when the signal fires is abortable
     * too — its own rejection reaches this turn's `catch` the same way. */
    readonly signal?: AbortSignal;
    /** Fires with each text delta across every provider call of this turn
     * (intermediate iterations included, tool calls excluded — mirrors the
     * Python oracle's `on_delta`). Absent means non-streaming. */
    readonly onDelta?: (delta: string) => void;
    /** Drains zero or more messages to append at the top of every iteration
     * of this turn (the first included), before the next request is built —
     * an orchestration adapter's steer inbox is the intended caller. Absent
     * means no injection, and the turn behaves exactly as it did before this
     * option existed. A thrown error is wrapped in MessageInjectionError and
     * propagated (never swallowed, never left silent); no request is built
     * for that iteration. */
    readonly drainMessages?: () => readonly Readonly<Record<string, unknown>>[];
    /** Issue #520 (M16-S5, ADR 0005): armed fresh before EVERY provider call
     * this turn issues (`interruptSource.arm(abort)`, disarmed in that
     * call's own `finally`, never left armed between calls) — an
     * orchestration adapter's `OrchestrationCore.steer` is the intended
     * caller, arming this per-child so a busy leaf's steer can tear a call
     * already in flight down instead of only queuing into the inbox for
     * the NEXT one (D2). Absent means no seam at all, and the turn behaves
     * exactly as it did before this option existed. */
    readonly interruptSource?: { readonly arm: (abort: () => void) => () => void };
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
    const emit = (
      type: ConversationRuntimeEvent["type"],
      code?: string,
      compaction?: ConversationRuntimeEvent["compaction"],
    ): void => {
      this.options.eventSink?.(
        Object.freeze({
          type,
          sessionId,
          ...(code === undefined ? {} : { code }),
          ...(compaction === undefined ? {} : { compaction }),
        }),
      );
    };
    emit("turn.started");
    let apiCalls = 0;
    // Issue #520 (D3, M16-S5, ADR 0005): how many of THIS turn's own calls
    // were torn down by a steer-driven interrupt and absorbed with
    // `continue` — surfaced on the result only when > 0 (see
    // `ConversationTurnResult.partialCalls`'s own doc).
    let partialCalls = 0;
    let usageTotal: Usage | null = null;
    let reasoningTotal = "";
    let historyBoundary = history.length;
    let compactedThisTurn = false;
    let compactionSummary: CompactionSummary | null = null;
    // Default summarizer: this runtime's own transport/model, with
    // SUMMARY_SYSTEM (see buildSummaryRequest, src/conversation/compaction.ts)
    // -- counted as real spend against this turn's apiCalls/usageTotal, same
    // as any other provider call the turn makes.
    const summarize =
      this.options.summarize ??
      (async (transcript: string): Promise<string> => {
        const summaryResponse = await this.options.transport.complete(
          buildSummaryRequest({ transcript, model: input.model, signal }),
        );
        apiCalls += 1;
        usageTotal = addUsage(usageTotal, summaryResponse.usage);
        return (summaryResponse.content ?? "").trim();
      });
    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        if (signalAborted(signal)) throw new ConversationCancelledError(sessionId, signal.reason);
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
        const compaction = await this.preflightCompact({
          sessionId,
          session,
          provider: input.provider,
          model: input.model,
          messages,
          historyBoundary,
          compactedThisTurn,
          summarize,
          emit,
        });
        if (compaction !== null) {
          historyBoundary = compaction.newHistoryBoundary;
          compactedThisTurn = true;
          compactionSummary = compaction.summary;
          emit("session.compacted", undefined, compaction.summary);
        }
        // preflightCompact's own await(s) open a gap this loop didn't have
        // before issue #252: re-check right before the call is issued so an
        // abort racing in during that gap is still caught pre-issuance
        // (never a hang waiting on a listener attached after the abort
        // event already fired) — same classification as the top-of-loop
        // check just above, just covering the newly-async preflight step.
        if (signalAborted(signal)) throw new ConversationCancelledError(sessionId, signal.reason);
        // Issue #520 (M16-S5, ADR 0005): a fresh AbortController PER CALL,
        // armed only for the lifetime of this one `transport.complete` —
        // `interruptSource` (an orchestration adapter's `OrchestrationCore`)
        // can fire `call.abort` any time a busy leaf gets steered, but only
        // while this call is actually the one in flight. The composite
        // `AbortSignal.any` means either the outer `signal` (external
        // cancel/shutdown, unchanged) or this call's own controller tears
        // the request down; `disarm()` in `finally` always clears the hook
        // back to `null` once this call settles, win or lose, so a steer
        // arriving BETWEEN calls (a tool running) never sees a live hook.
        const call = new AbortController();
        const disarm = input.interruptSource?.arm(() => {
          call.abort(new SteerInterrupt());
        });
        const request: ModelRequest = {
          system: session.systemPrompt,
          messages: immutableMessages(messages),
          model: input.model,
          temperature: input.temperature ?? null,
          effort: input.effort ?? null,
          maxTokens: this.options.maxTokens ?? null,
          tools: immutableMessages(
            (this.options.toolDefinitions ?? []) as readonly Readonly<Record<string, unknown>>[],
          ),
          signal: AbortSignal.any([signal, call.signal]),
          ...(input.onDelta ? { onText: input.onDelta } : {}),
        };
        emit("model.request.started");
        let response: NormalizedResponse;
        try {
          response = await this.options.transport.complete(request);
        } catch (error) {
          // The outer `signal` (external cancel/shutdown, S3) always takes
          // precedence: if IT is the one aborted, this is a cancellation
          // regardless of whether the per-call `call` controller also
          // fired in the same race — never reclassified into `continue`
          // below (contra-assertion,
          // tests/conversation-runtime-injection.test.ts).
          if (isAbortOf(error, signal)) {
            const partialUsage =
              error instanceof StreamAbortedError
                ? estimatePartialUsage(error.partial, {
                    system: request.system,
                    messages: request.messages,
                    tools: request.tools,
                  })
                : null;
            throw new ConversationCancelledError(sessionId, signal.reason, {
              partialUsage,
              apiCalls: apiCalls + 1,
            });
          }
          // Issue #520 (D2/D3): the outer `signal` never fired, but THIS
          // call's own controller did — a steer-driven interrupt tore this
          // call down mid-flight. Counted as spent (apiCalls, estimated
          // usage), never as a free retry — the turn absorbs it with
          // `continue`, discarding the partial response entirely (nothing
          // pushed to `messages`/`turnMessages`) and lets the NEXT
          // iteration's `drainMessages` inject whatever prompted the steer
          // in the first place.
          if (signalAborted(call.signal) && !signalAborted(signal)) {
            const partial =
              error instanceof StreamAbortedError ? error.partial : emptyPartialStream;
            apiCalls += 1;
            usageTotal = addUsage(
              usageTotal,
              estimatePartialUsage(partial, {
                system: request.system,
                messages: request.messages,
                tools: request.tools,
              }),
            );
            partialCalls += 1;
            emit("model.request.interrupted");
            continue;
          }
          throw new ConversationTurnFailedError(sessionId, providerMessage(error), error);
        } finally {
          disarm?.();
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
          compaction: compactionSummary,
          ...(partialCalls > 0 ? { partialCalls } : {}),
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
