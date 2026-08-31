import type { ClosableClient, ClientPool } from "../agent/client-pool.js";
import { configureFor } from "../agent/client-pool.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  ConversationCancelledError,
  ConversationRuntime,
  MaxIterationsError,
  ResponsesModel,
} from "../conversation/index.js";
import type { ModelTransport } from "../conversation/index.js";
import type { ProviderProfile } from "../providers/index.js";
import type { SessionRepository } from "../state/index.js";
import { childToolDefinitions, createChildDispatch, RegistryToolDispatcher } from "../tools/index.js";
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
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildTransport(client: ClosableClient, streaming: boolean): ModelTransport {
  if (client instanceof AnthropicMessagesClient) return new AnthropicMessagesModel(client, streaming);
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
 * Effort overrides (SpawnConfig.effort) are accepted by the type but not yet
 * forwarded: ConversationRuntime's ModelRequest has no effort field today,
 * and none of the three ModelTransport wrappers pass it to the transport
 * layer's BuildKwargsOptions.effort — a pre-existing gap in shared
 * conversation/*.ts, not something this ticket introduced. Escalated to the
 * coordinator; tracked as a carried debt until authorized.
 */
export function createChildRunner(options: CreateChildRunnerOptions): ChildRunner {
  return async (
    subId: string,
    config: SpawnConfig,
    systemPrompt: string,
    drainMessages: () => readonly Readonly<Record<string, unknown>>[],
  ): Promise<CollectResult> => {
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
    const model = (configured?.["model"] as string | undefined) ?? modelOverride ?? options.defaultModel;
    const maxIterations = config.maxIterations ?? options.childMaxIterations;

    // ConversationRuntime.runTurn() only creates a session when sessionId is
    // OMITTED (letting its own idSource() mint one); an explicit sessionId
    // with no existing row throws SESSION_NOT_FOUND instead. OrchestrationCore
    // already minted subId before calling this runner, so the row has to be
    // created here, once, before the first turn — every later steer-driven
    // resurrection then hits the "existing session" branch naturally.
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
    });

    try {
      const result = await runtime.runTurn({
        input: config.prompt,
        provider: profile.name,
        model,
        cwd: options.cwd,
        sessionId: subId,
        drainMessages,
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
      const message = error instanceof Error ? error.message : String(error);
      return zeroResult("error", message, profile, model, null, errorKind, retryAfter);
    }
  };
}
