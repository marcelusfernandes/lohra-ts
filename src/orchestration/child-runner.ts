import type { ClosableClient, ClientPool } from "../agent/client-pool.js";
import { configureFor } from "../agent/client-pool.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  ConversationCancelledError,
  ConversationRuntime,
  MaxIterationsError,
  ResponsesModel,
  type ConversationRuntimeOptions,
} from "../conversation/index.js";
import type { ModelTransport } from "../conversation/index.js";
import type { ProviderProfile } from "../providers/index.js";
import { formatProviderFailureMessage } from "../serialization/provider-error-message.js";
import type { SessionRepository } from "../state/index.js";
import {
  childToolDefinitions,
  createChildDispatch,
  RegistryToolDispatcher,
} from "../tools/index.js";
import type { RegistryDispatch, ToolDefinition } from "../tools/index.js";
import {
  AnthropicMessagesClient,
  ChatCompletionsClient,
  classifyProviderError,
  ResponsesClient,
  retryAfterSeconds,
} from "../transports/index.js";
import { ChildConversationRepository } from "./child-repository.js";
import type { ChildRunner, CollectResult, SpawnConfig } from "./core.js";
import { NonClosingTransport } from "./non-closing-transport.js";

export interface CreateChildRunnerOptions {
  readonly sessions: SessionRepository;
  readonly parentSessionId: string;
  readonly clientPool: ClientPool;
  readonly baseDispatch: RegistryDispatch;
  readonly parentToolDefinitions: readonly ToolDefinition[];
  readonly defaultModel: string;
  readonly cwd: string;
  readonly idSource: () => string;
  readonly clock: () => number;
  /** contract L10: the child's own leash, unrelated to LOHRA_MAX_ITERATIONS
   * (which bounds only the parent). Overridden per-spawn by
   * SpawnConfig.maxIterations (authored, 1-128), never by env. */
  readonly childMaxIterations: number;
  /** The same operator-configured price table commands/chat.ts loads for
   * the parent (loadPriceOverrides(pricing.json)) — a child's own turn
   * persists a real cost via ConversationRuntime.commitUsage, so an
   * override that applies to the parent's usage must apply to a child's
   * too. Absent means the built-in price table only, same as the parent
   * when no pricing.json exists. */
  readonly pricingOverrides?: ConversationRuntimeOptions["pricingOverrides"];
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildTransport(client: ClosableClient, streaming: boolean): ModelTransport {
  if (client instanceof AnthropicMessagesClient)
    return new AnthropicMessagesModel(client, streaming);
  if (client instanceof ResponsesClient) return new ResponsesModel(client);
  return new ChatCompletionsModel(client as ChatCompletionsClient, streaming);
}

function zeroResult(
  status: CollectResult["status"],
  output: string,
  profile: ProviderProfile,
  model: string,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  } | null,
  errorKind: string | null,
  retryAfter: number | null,
): CollectResult {
  return {
    status,
    output,
    tokensIn: usage?.inputTokens ?? 0,
    tokensOut: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    provider: profile.name,
    model,
    forcedFallback: false,
    errorKind,
    retryAfter,
  };
}

/**
 * Builds the real ChildRunner: a fresh ConversationRuntime per turn, wired to
 * ClientPool (provider/model resolution — contract L1/L9), the child's own
 * SQLite-backed repository (L21, source:'orchestration'), and the inherited,
 * unedited child.ts allow-list dispatch (L2/L4, errata E2). systemPrompt is
 * accepted as an already-frozen string and never rebuilt — the caller
 * (OrchestrationCore's buildSubagentPrompt, captured once at spawn) owns
 * decision 25's freeze invariant; this function only reuses it.
 *
 * Effort overrides (SpawnConfig.effort) are forwarded via runTurn's own
 * effort input — added to ModelRequest/ConversationRuntime/the three
 * ModelTransport wrappers as a dedicated, coordinator-authorized additive
 * extension (mirroring drainMessages: absent means null, neutral for the
 * parent's own chat command, which never sets it since the oracle's own
 * parent CLI has no effort flag either).
 */
export function createChildRunner(options: CreateChildRunnerOptions): ChildRunner {
  return async (
    subId: string,
    config: SpawnConfig,
    systemPrompt: string,
    drainMessages: () => readonly Readonly<Record<string, unknown>>[],
    signal: AbortSignal,
  ): Promise<CollectResult> => {
    // ChildRunner's contract (see core.ts) is to always RESOLVE, never
    // reject — OrchestrationCore.runAndTrack has no .catch, so a rejection
    // here would leave the SubSession entry permanently inFlight and,
    // worse, propagate through delegate()'s Promise.all and break L17's
    // per-task failure isolation for every OTHER task in the same batch.
    // Provider/model resolution (a real, reachable failure — an unknown or
    // unauthorized per-task override in delegate_task, or defense-in-depth
    // for spawn_session even though that path is pre-checked by the tool
    // intercept for the zero-registry-rows tripwire) therefore has to be
    // inside this try, not before it.
    const fallbackProvider = nonEmpty(config.provider) ?? "unknown";
    const fallbackModel = nonEmpty(config.model) ?? options.defaultModel;
    try {
      const providerOverride = nonEmpty(config.provider);
      const modelOverride = nonEmpty(config.model);
      const configured = await configureFor(options.clientPool, {
        provider: providerOverride,
        model: modelOverride,
      });
      const configuredProvider = configured?.["provider"] as ProviderProfile | undefined;
      const configuredClient = configured?.["client"] as ClosableClient | undefined;
      const [profile, client]: readonly [ProviderProfile, ClosableClient] =
        configuredProvider !== undefined && configuredClient !== undefined
          ? [configuredProvider, configuredClient]
          : await options.clientPool.get(null);
      const model =
        (configured?.["model"] as string | undefined) ?? modelOverride ?? options.defaultModel;
      const effort = nonEmpty(config.effort);
      const maxIterations = config.maxIterations ?? options.childMaxIterations;

      // ConversationRuntime.runTurn() only creates a session when sessionId
      // is OMITTED (letting its own idSource() mint one); an explicit
      // sessionId with no existing row throws SESSION_NOT_FOUND instead.
      // OrchestrationCore already minted subId before calling this runner,
      // so the row has to be created here, once, before the first turn —
      // every later steer-driven resurrection then hits the "existing
      // session" branch naturally.
      const repository = new ChildConversationRepository(options.sessions, options.parentSessionId);
      if (repository.session(subId) === null) {
        repository.createSession({ id: subId, systemPrompt, model, cwd: options.cwd });
      }

      const runtime = new ConversationRuntime({
        repository,
        transport: new NonClosingTransport(buildTransport(client, true)),
        promptSnapshot: () => systemPrompt,
        toolDefinitions: childToolDefinitions(options.parentToolDefinitions),
        toolDispatcher: new RegistryToolDispatcher(createChildDispatch(options.baseDispatch)),
        idSource: options.idSource,
        clock: options.clock,
        maxTokens: profile.defaultMaxTokens,
        maxIterations,
        pricingOverrides: options.pricingOverrides,
      });

      try {
        const result = await runtime.runTurn({
          input: config.prompt,
          provider: profile.name,
          model,
          cwd: options.cwd,
          sessionId: subId,
          drainMessages,
          effort,
          signal,
        });
        return zeroResult(
          "complete",
          result.response.content ?? "",
          profile,
          model,
          result.usageTotal,
          null,
          null,
        );
      } catch (error) {
        if (error instanceof ConversationCancelledError) {
          return zeroResult("interrupted", "", profile, model, null, null, null);
        }
        if (error instanceof MaxIterationsError) {
          return zeroResult("error", error.message, profile, model, error.usage, null, null);
        }
        const cause = error instanceof Error ? error.cause : undefined;
        const errorKind = classifyProviderError(cause);
        const retryAfter = errorKind === "quota_exhausted" ? retryAfterSeconds(cause) : null;
        const message = formatProviderFailureMessage(error);
        return zeroResult("error", message, profile, model, null, errorKind, retryAfter);
      }
    } catch (resolutionError) {
      const message =
        resolutionError instanceof Error ? resolutionError.message : String(resolutionError);
      return {
        status: "error",
        output: message,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        provider: fallbackProvider,
        model: fallbackModel,
        forcedFallback: false,
        errorKind: null,
        retryAfter: null,
      };
    }
  };
}
