import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadProjectContext,
  buildSystemPrompt,
  doctrineText,
  harnessText,
  resolveDoctrineTier,
  type PromptMode,
} from "../context/index.js";
import { createTurnNoticesPort } from "../context/notices-overlay.js";
import { readCodexModel } from "../auth/codex.js";
import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
import { RefreshFailedError, TokenPersistError } from "../auth/errors.js";
import { AuxClient } from "../agent/aux.js";
import { ClientPool } from "../agent/client-pool.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  ConversationError,
  ConversationRuntime,
  errorEnvelope,
  IncompleteToolCallError,
  MaxIterationsError,
  ResponsesModel,
  SqliteConversationRepository,
  successEnvelope,
} from "../conversation/index.js";
import type { ConversationRuntimeEvent } from "../conversation/index.js";
import { OpenAIImagesAdapter } from "../media/index.js";
import { registerConfiguredMcpServers } from "../mcp/index.js";
import type { MCPManager } from "../mcp/index.js";
import { loadSoul, MemoryStore } from "../memory/index.js";
import { buildOrchestrationCore, orchestrationToolHandlers } from "../orchestration/chat-wiring.js";
import { resolveFanout } from "../orchestration/fanout-config.js";
import { loadPriceOverrides } from "../pricing/index.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  knownProviderNames,
  resolveApiKey,
  type ProviderProfile,
} from "../providers/index.js";
import { stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";
import { openStateForEnvironment, SessionRepository } from "../state/index.js";
import { SkillStore } from "../skills/index.js";
import { approval, RegistryToolDispatcher } from "../tools/index.js";
import {
  AnthropicMessagesClient,
  buildClient,
  ChatCompletionsClient,
  createResponsesClient,
  getTransport,
  ResponsesClient,
} from "../transports/index.js";
import type { ModelTransport } from "../conversation/index.js";
import { formatProviderFailureMessage } from "../serialization/provider-error-message.js";
import { runChatBoundary } from "./chat-boundary.js";
import { detectChatProvider, type ChatProviderDetection } from "./provider-detectado.js";
import { CHAT_TOOL_REGISTRY_FACTORIES } from "./chat-tools.js";
import { subscriptionProviderRefusal } from "./subscription-guard.js";
import { composeSessionTools, createSessionToolBase } from "./session-tools.js";
import {
  AuditTrail,
  OrchestrationChildRuntime,
  productionOwnershipStore,
  templateLoader,
  workflowStatusHandler,
  WorkflowService,
} from "../workflow/index.js";
// Issue #369: not re-exported by `../workflow/index.js` — Files omits
// `src/workflow/index.ts`, so this imports the module directly.
import { WorkflowLiveTail } from "../workflow/live-tail.js";

export interface ChatCommandOptions {
  // Both already resolved by cli.ts's single parseCommand(CHAT_SPEC, ...)
  // call — this function never re-scans argv itself, so it can't drift
  // from what was actually validated the way its old standalone prompt()/
  // option() helpers once did (that drift caused `chat --max-parallel 4
  // hi` to misread "4" as the prompt, and `chat --sess x hi` — an
  // unambiguous prefix of --session the validator already accepted — to
  // do the same).
  readonly input: string;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly codexHome: string;
  readonly cwd: string;
}

type Result = Readonly<{ code: number; stdout: string; stderr: string }>;

function stringFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function finite(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`CHAT_OPTION_INVALID:${name}`);
  return result;
}

// `stderrMessage` defaults to the envelope message: most initialization
// failures use the same short text on both channels. The unknown-provider
// case is the exception (see its call site below) — the oracle puts a
// generic envelope message on stdout and a separate, detailed one (with
// the full known-provider list) on stderr.
function initializationError(
  input: string,
  model: string | null,
  message: string,
  stderrMessage: string = message,
): Result {
  return {
    code: 2,
    stdout: `${stringifyJsonPreservingNumbers({
      session_id: "",
      model,
      temperature: null,
      input,
      output: null,
      reasoning: null,
      tool_calls: [],
      usage: null,
      usage_total: null,
      cost: null,
      stop_reason: null,
      completed: false,
      error: message,
      api_calls: 0,
    })}\n`,
    stderr: `${stderrMessage}\n`,
  };
}

// Matches the short envelope message chat-boundary.ts already uses for
// "route.mode !== subscription with no --provider" — the same generic text
// the oracle shows across every no-provider-resolved chat failure.
const NO_PROVIDER_CONFIGURED_SHORT =
  "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr";

export function createChatSessionRegistry(
  database: Parameters<(typeof CHAT_TOOL_REGISTRY_FACTORIES)["public"]>[0],
  environment: Parameters<(typeof CHAT_TOOL_REGISTRY_FACTORIES)["public"]>[1],
) {
  return CHAT_TOOL_REGISTRY_FACTORIES.public(database, environment);
}

export async function runChat(options: ChatCommandOptions): Promise<Result> {
  const input = options.input;
  const provider = stringFlag(options.flags, "--provider");
  const route = resolveAuthRoute(options.home);
  if (route.error)
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
  // Issue #604: `--provider`-less `api_key` route now uses `doctor`'s own
  // `detected_provider` rule instead of always falling to the boundary.
  const detected =
    provider === undefined && route.mode !== "subscription"
      ? detectChatProvider(options.environment)
      : null;
  if (detected?.provider === null) {
    if (detected.detail !== null)
      return initializationError(input, null, NO_PROVIDER_CONFIGURED_SHORT, detected.detail);
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
  }

  // Minted up front so it's known before ClientPool/OrchestrationCore/
  // createChildRunner are constructed below (parent_session_id is fixed at
  // their construction time, L21) — idSource is wired to return this same
  // value later, so runTurn ends up with an identical sessionId either way,
  // whether --session was given or not.
  const parentSessionId =
    stringFlag(options.flags, "--session") ?? randomUUID().replaceAll("-", "");

  let profile: ProviderProfile;
  let client: ChatCompletionsClient | AnthropicMessagesClient | ResponsesClient;
  let modelTransport: ModelTransport;
  let model: string | undefined;
  let imageGenerator: OpenAIImagesAdapter | undefined;
  if (route.mode === "subscription") {
    // Issue #440 (option A, orchestrator decision): an explicit --provider
    // in subscription mode used to be silently ignored (a stderr note) while
    // --model still reached the Codex Responses transport — a route mismatch
    // the provider only caught with a 400. Refuse before any network call
    // (ahead of resolveCredentials, so a near-expiring token never triggers
    // a wasted refresh POST): --provider names a route this mode can't take,
    // and the actionable fix is a preference switch, not a retry.
    // --model alone (no --provider) is unaffected — it is how an operator
    // picks the subscription's own model and must keep going to Codex.
    const refusal = subscriptionProviderRefusal(provider);
    if (refusal !== null) return initializationError(input, null, refusal);
    let credentials;
    try {
      credentials = await resolveCredentials(options.home, { codexHome: options.codexHome });
    } catch (error) {
      // Was `catch {}` swallowing every error and falling through to
      // runChatBoundary unconditionally (issue #351, invariant 2: nothing
      // silent). A refresh-attempt failure specifically has a second bug on
      // top of the swallow: runChatBoundary calls resolveCredentials again
      // from scratch, a second OAuth refresh POST whose outcome can differ
      // from this one, formatted behind a generic "subscription transport
      // is not available" message that hides which attempt actually failed
      // and why. Surface that case directly instead — same shape
      // dashboard.ts/client-pool.ts already use for this error. Every other
      // SubscriptionError (not logged in, ToS not acknowledged, expired
      // Codex token) never touches the network, so re-resolving through
      // runChatBoundary is harmless and stays byte-identical to before
      // (tests/auth-cli.test.ts pins that shape).
      //
      // `TokenPersistError` (issue #354: the refresh POST itself succeeded,
      // only the disk write failed) needs the same direct treatment for a
      // different reason (issue #357): the refresh_token the provider
      // handed back has already been rotated, so a second attempt through
      // runChatBoundary re-reads the OLD token still on disk and retries
      // the refresh with a value the provider already invalidated — not
      // recoverable by retrying, only by fixing the disk and rerunning.
      // `TokenPersistError.message` already names the path and cause
      // without echoing any token value (`credentials.ts`), so it is safe
      // to surface as-is.
      if (error instanceof RefreshFailedError || error instanceof TokenPersistError)
        return initializationError(input, null, error.message);
      return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
    }
    if (credentials === null)
      return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
    profile = CODEX_PROVIDER;
    model = stringFlag(options.flags, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
    client = createResponsesClient({
      baseUrl: credentials.baseUrl,
      token: credentials.token,
      accountId: credentials.accountId,
      headers: credentials.headers,
    });
    modelTransport = new ResponsesModel(client);
  } else {
    // Guard above already returned when both are null (issue #604).
    const resolvedProviderName = provider ?? (detected as ChatProviderDetection).provider;
    if (resolvedProviderName === null) throw new Error("internal: no provider resolved (#604)");
    const resolved = getProviderProfile(resolvedProviderName);
    if (resolved === null)
      return initializationError(
        input,
        null,
        NO_PROVIDER_CONFIGURED_SHORT,
        `unknown provider '${resolvedProviderName.toLowerCase()}' (known: ${knownProviderNames().join(", ")})`,
      );
    profile =
      options.environment.LOHRA_PROVIDER_BASE_URL === undefined
        ? resolved
        : Object.freeze({ ...resolved, baseUrl: options.environment.LOHRA_PROVIDER_BASE_URL });
    model = stringFlag(options.flags, "--model") ?? profile.fallbackModels[0];
    const key = resolveApiKey(profile.name, options.environment);
    if (profile.apiMode === "chat_completions" && key === null && profile.requiresApiKey) {
      const message =
        `could not initialize the ${profile.name} client: Missing credentials. ` +
        "Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.";
      return initializationError(input, model ?? null, message);
    }
    const apiKey = key ?? (profile.name === "ollama" ? "lohra-local" : "");
    client = buildClient(profile, apiKey);
    if (profile.apiMode === "chat_completions") {
      imageGenerator = new OpenAIImagesAdapter({ apiKey, baseUrl: profile.baseUrl });
    }
    const streaming = !options.flags.has("--json");
    modelTransport =
      client instanceof AnthropicMessagesClient
        ? new AnthropicMessagesModel(client, streaming)
        : new ChatCompletionsModel(client, streaming);
  }
  if (model === undefined) {
    const message = `provider '${profile.name}' has no default model — pass --model.`;
    return {
      code: 2,
      stdout: errorEnvelope({
        sessionId: "",
        model: null,
        prompt: input,
        error: message,
        apiCalls: 0,
      }),
      stderr: `${message}\n`,
    };
  }
  const temperature = finite(stringFlag(options.flags, "--temperature"), "temperature") ?? null;
  const maxIterations = finite(stringFlag(options.flags, "--max-iterations"), "max-iterations");
  const fanout = resolveFanout(
    stringFlag(options.flags, "--max-parallel"),
    maxIterations,
    options.environment,
  );
  const warningLines = fanout.warnings.map((warning) => `${warning}\n`).join("");
  const connection = openStateForEnvironment(options.environment);
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  // Issue #401: the ownership store is built AFTER `sessionToolBase` (it
  // needs `sessionToolBase.noticesSink.warnState`, below) but the sink's
  // `ownership` resolver needs the store — a mutable one-field box breaks
  // the cycle: `ownership` only ever READS `ownershipRef.store` once a
  // run is live, long after it is assigned, never before.
  const ownershipRef: { store?: ReturnType<typeof productionOwnershipStore> } = {};
  const sessionToolBase = createSessionToolBase(connection.database, options.environment, {
    ownership: (runId) => {
      const store = ownershipRef.store;
      if (store === undefined) return null;
      const fence = store.locks.runFenceOf(runId);
      return fence === null ? null : { fence, holder: store.holder, now: store.ownershipOf().now };
    },
  });
  const sessionRegistry = sessionToolBase.registry;
  const repository = new SqliteConversationRepository(sessions);
  const useTools = !options.flags.has("--no-tools");
  const memoryStore = new MemoryStore(options.home);
  const builtinSkills = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../assets/skills/workflow-authoring",
  );
  const skillStore = new SkillStore(
    options.home,
    [join(options.cwd, ".claude", "skills")],
    [builtinSkills],
  );
  // Issue #579 (épico #575, P3): resolvido uma vez por sessão, aqui — nunca
  // dentro de `snapshot` — porque o system prompt é construído uma vez por
  // sessão e congelado (invariante 1 do CLAUDE.md); `profile` já está fixo
  // neste ponto (linha 251 acima).
  const doctrine = doctrineText(
    resolveDoctrineTier({ providerName: profile.name, environment: options.environment }),
  );
  // Issue #580 (épico #575, P4): "headless" sob --json/--no-input (nenhum
  // humano observando este turno em tempo real, sem stdin para retomar uma
  // conversa) e "interactive" caso contrário — mesma regra que
  // `chat.ts:332` já usa para decidir o callback de aprovação. `yolo` é
  // exatamente a flag `--yolo` (`CHAT_SPEC`, `src/cli/arg-spec.ts:58`), a
  // única exceção real à negação automática (`src/tools/approval.ts`).
  // Resolvido uma vez aqui, como `doctrine` acima — nunca dentro de
  // `snapshot`.
  const mode: PromptMode =
    options.flags.has("--json") || options.flags.has("--no-input") ? "headless" : "interactive";
  const harness = harnessText({ mode, yolo: options.flags.has("--yolo") });
  // Issue #586 (épico #575, 2ª rodada): devolve a SystemPromptSnapshot
  // inteira, não mais só `.text` — ConversationRuntime.promptSnapshot já
  // aceita `string | SystemBands`; a faixa cheia chega ao transporte
  // Anthropic (cache_control em stable+context) e à persistência
  // (SqliteConversationRepository grava as três colunas). `snapshot` não é
  // usada em nenhum outro lugar deste arquivo, então este é o único call
  // site afetado.
  const snapshot = () => {
    const context = loadProjectContext(options.cwd);
    const identity = loadSoul(options.home);
    // Issue #580 AC 2: memória, perfil e índice de skills entram no prompt
    // mesmo sob --no-tools — a tool `memory`/`skill_view` some (`useTools`
    // ainda controla o registro das tools abaixo), mas o CONHECIMENTO não;
    // só a leitura em disco é sempre feita, nunca condicionada a `useTools`.
    const memory = memoryStore.snapshot();
    return buildSystemPrompt({
      ...(identity === undefined ? {} : { identity }),
      doctrine,
      harness,
      contextFiles: context.instructions,
      environmentHints: context.hints,
      ...(memory.memory ? { memorySnapshot: memory.memory } : {}),
      ...(memory.user ? { userProfile: memory.user } : {}),
      skillsIndex: skillStore.snapshot(),
    });
  };
  approval.reset();
  approval.setYolo(options.flags.has("--yolo"));
  approval.setCallback(
    options.flags.has("--json") || options.flags.has("--no-input") ? () => "deny" : null,
  );
  // MCP tools are registered on the per-session registry so T17's durable
  // workflow_audit override and T19's dynamic tools share one definition and
  // dispatch snapshot.
  let mcpManager: MCPManager | null = null;
  if (useTools) {
    mcpManager = await registerConfiguredMcpServers(sessionRegistry, {
      configPath: join(options.home, "mcp.json"),
    });
  }
  const baseDispatch = sessionRegistry.dispatch.bind(sessionRegistry);
  const clientPool = new ClientPool(profile, client, {
    home: options.home,
    codexHome: options.codexHome,
    environment: options.environment,
  });
  // Issue #587 (AC1): same provider/client as the turn itself, `defaultAuxModel`
  // when the profile has one — absent, `aux`/`auxTelemetry` stay undefined and
  // this turn behaves exactly as it did before this issue (no `summarize`
  // override, no title). `getTransport` never fails for a profile this route
  // already validated (`profile.apiMode` is always registered).
  const auxTransport = profile.defaultAuxModel ? getTransport(profile.apiMode) : null;
  const aux =
    auxTransport === null
      ? null
      : new AuxClient({
          client,
          transport: auxTransport,
          chosenModel: model,
          defaultAuxModel: profile.defaultAuxModel,
        });
  const auxTelemetry = aux?.auxTelemetry();
  const pricingOverrides = loadPriceOverrides(join(options.home, "pricing.json"));
  const orchestrationCore = buildOrchestrationCore({
    fanout,
    sessions,
    parentSessionId,
    clientPool,
    baseDispatch,
    parentToolDefinitions: sessionRegistry.getDefinitions(),
    defaultModel: model,
    cwd: options.cwd,
    pricingOverrides,
  });
  // Issue #369: the ring buffer is per-process, per-service; `push` never
  // throws (a bad event never aborts the run it watches), so wiring it
  // straight into `onLiveEvent` is safe unconditionally. Issue #401: the
  // ONE sink `sessionToolBase` built, not a fresh `console.warn` closure.
  const liveTail = new WorkflowLiveTail(sessionToolBase.noticesSink.warn);
  // Durable by default: the store is built over THIS root's own
  // connection.database (#101), never a second one, and the leaf sandbox
  // OrchestrationChildRuntime now installs (#107) is what lets its runs
  // actually spawn tool-using leaves instead of denying them fail-closed.
  // Issue #401: `warning` routes a `StateWarning` straight into
  // `sessionToolBase.noticesSink.warnState` — still prints to stderr via
  // the sink's own fallback (a refused owned write never disappears in
  // silence, #135) AND records the same warning in `operator_notices`.
  // Issue #426 (3ª emenda): `notices` is the SAME repository
  // `sessionToolBase.noticesRepository`/`workflow_notices` already share —
  // a route fault's lesson lands as a durable notice, not just a `warn`.
  const store = productionOwnershipStore(connection.database, {
    warning: sessionToolBase.noticesSink.warnState,
    notices: sessionToolBase.noticesRepository,
  });
  ownershipRef.store = store;
  const workflowService = new WorkflowService({
    runtime: new OrchestrationChildRuntime(orchestrationCore),
    environment: options.environment,
    homeRoot: options.home,
    loader: templateLoader(options.home),
    store,
    auditTrail: new AuditTrail(sessionToolBase.auditRepository, {
      warning: sessionToolBase.noticesSink.warn,
    }),
    // Issue #401: unifies this process's `WorkflowService`-level warnings
    // (`this.warn` inside `service.ts`) into the same sink.
    onWarning: sessionToolBase.noticesSink.warn,
    onLiveEvent: (event) => {
      liveTail.push(event);
    },
  });
  const tools = composeSessionTools({
    base: sessionToolBase,
    home: options.home,
    cwd: options.cwd,
    environment: options.environment,
    sessions,
    workflowService,
    orchestrationHandlers: orchestrationToolHandlers(orchestrationCore, clientPool),
    visionRunner: modelTransport,
    ...(imageGenerator === undefined ? {} : { imageGenerator }),
    visionModel: model,
    imageModel: model,
    supportsVision: profile.supportsVision,
  });
  // `composeSessionTools` (`session-tools.ts:93`, outside this issue's
  // Files) wires `workflow_status` tail-less — this second, narrower
  // override is the one call that actually threads `liveTail` into the
  // tool surface, same registry, same generation bump.
  tools.registry.overrideHandlers({
    workflow_status: workflowStatusHandler(workflowService, liveTail),
  });
  // Issue #287: nothing that constructs a ConversationRuntime in production
  // wired `eventSink` before this -- "session.compacted"/
  // "compaction.unsupported" only ever reached a test's own fake sink.
  // successEnvelope already surfaces the fold summary via `compaction`
  // (issue #252) when `--json` is set, but that key is silent about WHY a
  // turn's output looks shorter/different for a non-`--json` run, and about
  // `compaction.unsupported` at all (the fail-open path never touches the
  // envelope). Collected here (not written directly to `options` -- there
  // is no live stream to write to, this command answers once) and appended
  // to `stderr` below, next to the existing warnings/session-resume line.
  const compactionEvents: string[] = [];
  // Issue #589: the SAME `noticesRepository` `workflow_notices` already
  // reads from — a pending notice this turn overlays is the one an
  // operator would otherwise only see by calling that tool.
  const notices = createTurnNoticesPort({
    repository: sessionToolBase.noticesRepository,
    sessions,
    warning: sessionToolBase.noticesSink.warn,
  });
  const runtime = new ConversationRuntime({
    repository,
    transport: modelTransport,
    promptSnapshot: snapshot,
    environment: options.environment,
    notices,
    eventSink: (event: ConversationRuntimeEvent) => {
      if (event.type === "session.compacted" && event.compaction !== undefined) {
        compactionEvents.push(
          `event: session.compacted summarized=${String(event.compaction.summarizedCount)} kept=${String(event.compaction.keptCount)}\n`,
        );
      } else if (event.type === "compaction.unsupported") {
        compactionEvents.push("event: compaction.unsupported\n");
      } else if (event.type === "compaction.transcript_truncated") {
        compactionEvents.push("event: compaction.transcript_truncated\n");
      } else if (event.type === "compaction.aux_fallback") {
        compactionEvents.push(`event: compaction.aux_fallback code=${event.code ?? ""}\n`);
      }
    },
    ...(auxTelemetry === undefined ? {} : { summarize: auxTelemetry.summarize }),
    ...(useTools
      ? {
          toolDefinitions: tools.toolDefinitions,
          toolDispatcher: new RegistryToolDispatcher(tools.dispatch),
        }
      : {}),
    idSource: () => parentSessionId,
    clock: () => Date.now() / 1000,
    maxTokens: profile.defaultMaxTokens,
    maxIterations: fanout.parentMaxIterations,
    pricingOverrides,
  });
  try {
    const sessionId = stringFlag(options.flags, "--session");
    // Issue #623: generated BEFORE runTurn, from the same `input` the user
    // gave (byte-identical to `result.input`, `runtime.ts:735`, the value
    // this used to read AFTER runTurn returned). `ConversationRuntime.
    // runTurn`'s own `finally` unconditionally closes `modelTransport`
    // (`runtime.ts:792`), which for this route forwards straight to the
    // same underlying `client` the `AuxClient` above wraps (L371-390) — a
    // title request issued after `runTurn` returns always hit an
    // already-closed client (`CLIENT_CLOSED`, diagnosed on issue #620).
    // Fail-open here exactly as before: a title failure never blocks the
    // turn, only skips persistence below.
    let title: string | null = null;
    if (sessionId === undefined && auxTelemetry !== undefined) {
      try {
        title = (await auxTelemetry.title(input)) || null;
      } catch (error) {
        compactionEvents.push(
          `event: title.failed code=${error instanceof Error ? error.name : "UNKNOWN"}\n`,
        );
      }
    }
    const result = await runtime.runTurn({
      input,
      provider: profile.name,
      model,
      temperature,
      cwd: options.cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    // Issue #587 AC ("ao criar a sessão... gerar e persistir title"):
    // persisted only once the session row is known to exist —
    // `result.sessionId` is the id `runTurn` just created via
    // `idSource`/`createSession`. Its own try/catch keeps a DB write
    // failure from turning an otherwise successful turn into an error
    // envelope (same fail-open contract as the title generation above).
    if (title !== null) {
      try {
        sessions.setTitle(result.sessionId, title);
      } catch (error) {
        compactionEvents.push(
          `event: title.failed code=${error instanceof Error ? error.name : "UNKNOWN"}\n`,
        );
      }
    }
    return {
      code: 0,
      stdout: options.flags.has("--json")
        ? successEnvelope(
            result,
            auxTelemetry === undefined
              ? undefined
              : { auxCalls: auxTelemetry.calls(), auxUsage: auxTelemetry.usage() },
          )
        : `${result.response.content ?? ""}\n`,
      stderr: `${warningLines}${compactionEvents.join("")}session: ${result.sessionId}  (resume with --session ${result.sessionId})\n`,
    };
  } catch (error) {
    const message = formatProviderFailureMessage(error);
    const sessionId = error instanceof ConversationError ? (error.sessionId ?? "") : "";
    const apiCalls = error instanceof ConversationError ? error.apiCalls : 0;
    const incomplete = error instanceof IncompleteToolCallError ? error : null;
    const bounded = error instanceof MaxIterationsError ? error : null;
    return {
      code: 1,
      stdout: errorEnvelope({
        sessionId,
        model,
        prompt: input,
        error: message,
        apiCalls,
        ...(incomplete === null && bounded === null
          ? {}
          : {
              usage: (incomplete ?? bounded)?.usage ?? null,
              ...(bounded === null
                ? {}
                : { usage: bounded.lastUsage ?? bounded.usage, usageTotal: bounded.usage }),
              cost: (incomplete ?? bounded)?.cost ?? null,
              sessionSummary: (incomplete ?? bounded)?.sessionSummary ?? null,
              ...(bounded === null
                ? {}
                : { stopReason: bounded.stopReason, toolCalls: bounded.toolCalls }),
            }),
      }),
      stderr: `${warningLines}${compactionEvents.join("")}${sessionId ? `session: ${sessionId}  (resume with --session ${sessionId})\n` : ""}error: ${message}\n`,
    };
  } finally {
    approval.setCallback(null);
    approval.setYolo(false);
    approval.reset();
    // L16/assertions 40-41: drains every sub-session (interrupts cooperatively,
    // waits for each to actually settle) before the DB connection a child's
    // own write might still need goes away — same ordering as the oracle's
    // finally (shutdown before db.close()).
    await orchestrationCore.shutdown(options.home);
    // Children may dispatch MCP tools through the parent registry, so their
    // turns must settle before the MCP sessions are closed.
    if (mcpManager !== null) await mcpManager.shutdown();
    await imageGenerator?.close();
    // WorkflowService.shutdown() BEFORE connection.close() (#102): a durable
    // run's own completion handler releases its lease and writes its
    // terminal line while the connection is still open, instead of racing
    // this close and failing later against a closed one.
    await workflowService.shutdown();
    connection.close();
  }
}
