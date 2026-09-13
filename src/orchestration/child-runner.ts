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
  type ErrorKind,
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

/** Structural twin of `Usage` (`transports/types.ts`) — `zeroResult`'s own
 * parameter shape since before this issue; named here so `combineUsage`
 * below shares the exact same type instead of a second copy of the
 * literal. */
type LeafUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
} | null;

/** Issue #568 (r2, veredito da PR #573): sums two usage readings that are
 * NEVER both real or both estimated by construction —
 * `ConversationCancelledError.measuredUsage` (real, the turn's earlier
 * completed iterations) and `.partialUsage` (estimated, the one call that
 * got aborted) — into the single figure `zeroResult` reports as the leaf's
 * own `usage`. A `null` side is a no-op (never zero-filled): `null, null`
 * stays `null` (nothing measured at all, the plain #232 gap), and either
 * side alone passes through unchanged (the common case — only one of the
 * two is ever non-null outside a multi-iteration cancel). */
function combineUsage(a: LeafUsage, b: LeafUsage): LeafUsage {
  if (a === null) return b;
  if (b === null) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function zeroResult(
  status: CollectResult["status"],
  output: string,
  profile: ProviderProfile,
  model: string,
  usage: LeafUsage,
  errorKind: ErrorKind | null,
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
    errorKind,
    retryAfter,
    // #232: a turn with no usage object never measured anything — not a
    // turn that genuinely spent zero tokens. Covers "sem usage" (the
    // complete path when the provider reported none), "a folha morreu
    // antes de reportar" (ConversationCancelledError, always null) and
    // MaxIterationsError's own null case.
    usageUncertain: usage === null,
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
    // Issue #520 (M16-S5, ADR 0005): OrchestrationCore's own per-call
    // interrupt hook, forwarded verbatim to the real turn loop's
    // `interruptSource` below — this function never calls `arm`/the
    // returned disarm itself, only threads the object through.
    interrupts?: { readonly arm: (abort: () => void) => () => void },
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

      const childDispatch = createChildDispatch(options.baseDispatch);
      // The leaf sandbox wrap (workflow durable leaves, #107) applies ON TOP
      // of the child allow-list dispatch, never in place of it — the
      // exclusions in child.ts:57-78 still run first, and only what they let
      // through ever reaches the sandbox's fs/egress/taint checks.
      const dispatch =
        config.wrapDispatch === undefined
          ? childDispatch
          : config.wrapDispatch(childDispatch, subId);
      const runtime = new ConversationRuntime({
        repository,
        transport: new NonClosingTransport(buildTransport(client, true)),
        promptSnapshot: () => systemPrompt,
        toolDefinitions: childToolDefinitions(options.parentToolDefinitions),
        toolDispatcher: new RegistryToolDispatcher(dispatch),
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
          ...(interrupts === undefined ? {} : { interruptSource: interrupts }),
        });
        const content = result.response.content ?? "";
        // #429 (M10-S8): a turn that finishes with no final text AND no tool
        // calls executed anywhere in it is DEAD — the engine already treats
        // empty output as needing a respawn (isEmptyOutput, engine.ts); this
        // only gives that case a name instead of leaving errorKind null.
        // status/output are untouched (still "complete"/content) — the kind
        // only names, per the issue's decision 3 (aditivo, precedente #232).
        const isDeadTurn = content.trim() === "" && (result.toolCalls?.length ?? 0) === 0;
        const completeResult = zeroResult(
          "complete",
          content,
          profile,
          model,
          result.usageTotal,
          isDeadTurn ? "dead_turn" : null,
          null,
        );
        // Issue #520 (D3, M16-S5, ADR 0005): a turn that COMPLETED still
        // spent part of its usage on a call abandoned mid-stream (a steer
        // interrupt the loop absorbed with `continue`, never surfaced as a
        // failure) — `usageTotal` above already includes that ESTIMATED
        // portion (`ConversationRuntime.runTurn`'s own accounting), so the
        // result carries the same `partial`/forced `usageUncertain` markers
        // a cancelled turn with a partial gets, never a silent "fully
        // measured" claim.
        return result.partialCalls !== undefined && result.partialCalls > 0
          ? { ...completeResult, partial: true, usageUncertain: true }
          : completeResult;
      } catch (error) {
        if (error instanceof ConversationCancelledError) {
          // #518 (M16-S3, ADR 0005) + #568 (r2, veredito da PR #573): the
          // leaf's reported `usage` is the SUM of whatever real usage the
          // turn's earlier iterations already measured
          // (`error.measuredUsage`) and this call's own ESTIMATE
          // (`error.partialUsage`) — `combineUsage` above, never merged
          // upstream (see both fields' own doc, `errors.ts`). `usageUncertain`
          // is forced `true` regardless of what `zeroResult`'s own
          // null-check would have computed: even a fully-real
          // `measuredUsage` with no estimate at all is still "as of the
          // cancel", never a final, provider-confirmed total the way a
          // COMPLETED turn's usage is.
          //
          // `partial` stays derived from `partialUsage !== null` ALONE —
          // never from the combined `usage` — matching
          // `RunResult.partialLeaves`'s contract (`core.ts`,
          // `workflow/runtime.ts`, `builtin-definitions.ts`: a leaf counts
          // as partial only when its usage includes an ESTIMATED portion).
          // A cancel via `isAbortOf`'s 2nd/3rd form (no `StreamAbortedError`
          // to estimate from) after an earlier iteration already completed
          // for real reports that real `measuredUsage` as `usage`, but is
          // NOT partial — nothing in it was ever estimated. `partialUsage
          // === null` and `measuredUsage === null` together (pre-issuance
          // cancel, or a single-call turn aborted by a non-StreamAbortedError
          // form) stays the plain #232 "never measured" gap this already
          // was before #568.
          const usage = combineUsage(error.measuredUsage, error.partialUsage);
          return {
            ...zeroResult("interrupted", "", profile, model, usage, "cancelled", null),
            usageUncertain: true,
            partial: error.partialUsage !== null,
          };
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
        errorKind: null,
        retryAfter: null,
        // "erro de resolução" (#232) — provider/model never resolved, so no
        // call was ever attempted; the zero counters above are unmeasured.
        usageUncertain: true,
      };
    }
  };
}
