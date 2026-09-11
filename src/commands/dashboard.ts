import { generateSessionToken } from "../gateway/auth.js";
import { LEVELS } from "../cli/arg-validation.js";
import { registerShutdownTrigger } from "../cli/shutdown-trigger.js";
import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
import { readCodexModel } from "../auth/codex.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  resolveApiKey,
  type ProviderProfile,
} from "../providers/index.js";
import { loadProjectContext, buildSystemPrompt } from "../context/index.js";
import { openStateForEnvironment, SessionRepository } from "../state/index.js";
import { GatewaySessionRegistry } from "../gateway/session-service.js";
import { createGatewayToolRuntime } from "../gateway/tools.js";
import { createGatewayUpgradeHandler } from "../gateway/ws/connection.js";
import { startGatewayHttpServer } from "../gateway/http/server.js";
import { routeGatewayRequest, type RouteContext } from "../gateway/http/routes.js";
import { noProvider } from "./chat-boundary.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  ConversationRuntime,
  ResponsesModel,
  SqliteConversationRepository,
} from "../conversation/index.js";
import type { ModelTransport } from "../conversation/types.js";
import {
  AnthropicMessagesClient,
  buildClient,
  createResponsesClient,
  type ChatCompletionsClient,
  type ResponsesClient,
} from "../transports/index.js";
import { ClientPool } from "../agent/client-pool.js";
import { buildOrchestrationCore, orchestrationToolHandlers } from "../orchestration/chat-wiring.js";
import { resolveFanout } from "../orchestration/fanout-config.js";
import { loadPriceOverrides } from "../pricing/index.js";
import { OpenAIImagesAdapter } from "../media/index.js";
import { registerConfiguredMcpServers, type MCPManager } from "../mcp/index.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuditTrail,
  OrchestrationChildRuntime,
  productionOwnershipStore,
  workflowStatusHandler,
  WorkflowService,
} from "../workflow/index.js";
// Issue #369: not re-exported by `../workflow/index.js` — Files omits
// `src/workflow/index.ts`, so this imports the module directly.
import { WorkflowLiveTail } from "../workflow/live-tail.js";
import { composeSessionTools, createSessionToolBase } from "./session-tools.js";
import { CronStore } from "../cron/store.js";
import { runSchedulerLoop } from "../cron/scheduler.js";
import { RegistryToolDispatcher } from "../tools/index.js";

const GATEWAY_VERSION = "0.0.11";
const DEFAULT_PORT = 9119;
const DEFAULT_HOST = "127.0.0.1";

// `--host` fora deste conjunto expõe o gateway além do loopback, o gatilho
// de reavaliação registrado em `docs/gate-decision.md` (L22). Nomes, não
// endereços resolvidos por DNS: comparação literal, sem I/O de rede.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

// IPv6 literals need brackets in a URL authority (`http://[::1]:9119`); an
// IPv4 literal or hostname never contains ":", so this is a no-op for them.
function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export interface DashboardCommandOptions {
  // Already resolved by cli.ts's single parseCommand(DASHBOARD_SPEC, ...)
  // call (issue #222) -- this function never re-scans argv itself, so it
  // can't drift from what was actually validated the way its old
  // standalone option() helper (argv.indexOf(name)) once did: that helper
  // never recognized `--flag=value` nor unambiguous-prefix abbreviation,
  // even though parseCommand already accepted both and serve already read
  // from this same map.
  readonly flags: ReadonlyMap<string, string | true>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly codexHome: string;
  readonly cwd: string;
  readonly stderr: (text: string) => void;
  // Injectable for tests: 0 binds an ephemeral port and skips the
  // print-before-bind ordering (assertion 55) since there is no fixed port
  // to announce in advance; omit to use the real default 9119.
  readonly port?: number;
  // Injectable for tests: registers the shutdown trigger instead of a real
  // OS SIGINT, so a test can drive shutdown without signaling the whole
  // test process. Defaults to process.once("SIGINT", handler).
  readonly registerShutdownTrigger?: (handler: () => void) => void;
}

function stringFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

export async function runDashboard(options: DashboardCommandOptions): Promise<number> {
  const insecure = options.flags.has("--insecure");
  const host = stringFlag(options.flags, "--host") ?? DEFAULT_HOST;

  // Concretiza a reavaliação do L22 (`docs/gate-decision.md`): um `--host`
  // fora de loopback SEMPRE exige o token de sessão. Sem `--insecure` o
  // token já é obrigatório por padrão (nada a fazer); com `--insecure`, a
  // combinação é recusada aqui, antes de qualquer bind ou I/O de rede --
  // erro no mesmo formato dos erros de arg-spec (banner + `lohra: error:`).
  if (insecure && !isLoopbackHost(host)) {
    options.stderr(
      `${LEVELS.dashboard.banner}lohra: error: --insecure cannot be combined with --host ${host}: ` +
        "binding outside loopback (127.0.0.1, localhost, ::1) requires the session token\n",
    );
    return 2;
  }

  // Issue #221: LOHRA_DASHBOARD_SESSION_TOKEN="" (or whitespace-only) used
  // to fall through to `?? generateSessionToken()` untouched -- undefined is
  // "not set", but an empty string IS set, so the fallback never ran, and
  // the gateway ended up with an empty expectedToken. Combined with #4's
  // non-loopback --host, that opened the gateway on the network with no
  // real authentication (timingSafeTokenEqual("", "") used to be true).
  // Refused here, before route/credential resolution or any bind, same
  // CLI-shaped error as the --insecure refusal above.
  const rawToken = options.environment.LOHRA_DASHBOARD_SESSION_TOKEN;
  if (rawToken !== undefined && rawToken.trim() === "") {
    options.stderr(
      `${LEVELS.dashboard.banner}lohra: error: LOHRA_DASHBOARD_SESSION_TOKEN vazio; ` +
        "gere um token ou não defina a variável\n",
    );
    return 2;
  }

  const route = resolveAuthRoute(options.home);

  let model: string;
  let providerName: string;
  let profile: ProviderProfile;
  let poolClient: ChatCompletionsClient | AnthropicMessagesClient | ResponsesClient;
  let imageGenerator: OpenAIImagesAdapter | undefined;
  let createModelTransport: () => ModelTransport;
  if (route.mode === "subscription") {
    let credentials;
    try {
      credentials = await resolveCredentials(options.home, { codexHome: options.codexHome });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.stderr(`subscription mode: ${detail}\n`);
      return 2;
    }
    if (credentials === null) {
      options.stderr("subscription mode: not logged in\n");
      return 2;
    }
    model = stringFlag(options.flags, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
    // The real profile name ("openai-codex"), never the string literal
    // "codex" -- that alias was never registered on purpose (see
    // getProviderProfileIncludingCodex, src/providers/registry.ts), so it
    // used to make the gateway ws's own getProviderProfile(deps.provider)
    // resolve to null downstream: maxTokens fell back to 0 and the context
    // window resolution missed the Codex floor entirely (issue #287).
    providerName = CODEX_PROVIDER.name;
    profile = CODEX_PROVIDER;
    poolClient = createResponsesClient({
      baseUrl: credentials.baseUrl,
      token: credentials.token,
      accountId: credentials.accountId,
      headers: credentials.headers,
    });
    // T11's approved streaming seam (091d540) never gave ResponsesModel a
    // `streaming` constructor flag -- only ChatCompletionsModel and
    // AnthropicMessagesModel got one. This session's own provisional seam
    // had added one, but that commit was dropped at rebase per the
    // coordinator's ruling (drop-and-adopt T11's version outright, no
    // reconciliation). Reported as a real gap, not silently filled here:
    // the subscription/Codex path currently cannot stream deltas --
    // ResponsesModel.complete() always calls create(), which is a thin
    // wrapper always passing empty stream callbacks.
    createModelTransport = () =>
      new ResponsesModel(
        createResponsesClient({
          baseUrl: credentials.baseUrl,
          token: credentials.token,
          accountId: credentials.accountId,
          headers: credentials.headers,
        }),
      );
  } else {
    const provider = stringFlag(options.flags, "--provider");
    if (provider === undefined) {
      options.stderr(noProvider);
      return 2;
    }
    const resolvedProfile = getProviderProfile(provider);
    if (resolvedProfile === null) {
      options.stderr(`unknown provider '${provider.toLowerCase()}'\n`);
      return 2;
    }
    profile =
      options.environment.LOHRA_PROVIDER_BASE_URL === undefined
        ? resolvedProfile
        : Object.freeze({
            ...resolvedProfile,
            baseUrl: options.environment.LOHRA_PROVIDER_BASE_URL,
          });
    const key = resolveApiKey(profile.name, options.environment);
    if (profile.apiMode === "chat_completions" && key === null && profile.requiresApiKey) {
      options.stderr(
        `could not initialize the ${profile.name} client: Missing credentials. ` +
          "Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.\n",
      );
      return 2;
    }
    model = stringFlag(options.flags, "--model") ?? profile.fallbackModels[0] ?? "unknown";
    providerName = profile.name;
    const apiKey = key ?? (profile.name === "ollama" ? "lohra-local" : "");
    poolClient = buildClient(profile, apiKey);
    if (profile.apiMode === "chat_completions") {
      imageGenerator = new OpenAIImagesAdapter({ apiKey, baseUrl: profile.baseUrl });
    }
    if (route.note !== undefined) options.stderr(`${route.note}\n`);
    // Fresh client + transport per turn, streaming:true (this gateway's own
    // layer decides to stream -- onDelta alone does nothing, see the
    // provisional seam commit) -- matches "cada request cria Agent novo".
    createModelTransport = () => {
      const client = buildClient(profile, apiKey);
      return client instanceof AnthropicMessagesClient
        ? new AnthropicMessagesModel(client, true)
        : new ChatCompletionsModel(client, true);
    };
  }

  const token = rawToken ?? generateSessionToken();
  const context = loadProjectContext(options.cwd);
  const systemPrompt = buildSystemPrompt({
    contextFiles: context.instructions,
    environmentHints: context.hints,
  }).text;

  const connection = openStateForEnvironment(options.environment);
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  // Issue #401: the ownership store is built AFTER `toolBase` (it needs
  // `toolBase.noticesSink.warnState`, below) but the sink's `ownership`
  // resolver needs the store — a mutable one-field box breaks the cycle:
  // `ownership` only ever READS `ownershipRef.store` once a run is live,
  // long after it is assigned, never before.
  const ownershipRef: { store?: ReturnType<typeof productionOwnershipStore> } = {};
  const toolBase = createSessionToolBase(connection.database, options.environment, {
    ownership: (runId) => {
      const store = ownershipRef.store;
      if (store === undefined) return null;
      const fence = store.locks.runFenceOf(runId);
      return fence === null ? null : { fence, holder: store.holder, now: store.ownershipOf().now };
    },
  });
  let mcpManager: MCPManager | null = null;
  try {
    mcpManager = await registerConfiguredMcpServers(toolBase.registry, {
      configPath: join(options.home, "mcp.json"),
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  const clientPool = new ClientPool(profile, poolClient, {
    home: options.home,
    codexHome: options.codexHome,
    environment: options.environment,
  });
  const pricingOverrides = loadPriceOverrides(join(options.home, "pricing.json"));
  const orchestrationCore = buildOrchestrationCore({
    fanout: resolveFanout(undefined, undefined, options.environment),
    sessions,
    parentSessionId: randomUUID().replaceAll("-", ""),
    clientPool,
    baseDispatch: toolBase.registry.dispatch.bind(toolBase.registry),
    parentToolDefinitions: toolBase.registry.getDefinitions(),
    defaultModel: model,
    cwd: options.cwd,
    pricingOverrides,
  });
  // Issue #369: the ring buffer is per-process, per-service; `push` never
  // throws (a bad event never aborts the run it watches), so wiring it
  // straight into `onLiveEvent` is safe unconditionally. Issue #401: the
  // ONE sink `toolBase` built, not a fresh `console.warn` closure.
  const liveTail = new WorkflowLiveTail(toolBase.noticesSink.warn);
  // Durable by default: the store is built over THIS root's own
  // connection.database (#101), never a second one, and the leaf sandbox
  // OrchestrationChildRuntime now installs (#107) is what lets its runs
  // actually spawn tool-using leaves instead of denying them fail-closed.
  // Issue #401: `warning` routes a `StateWarning` straight into
  // `toolBase.noticesSink.warnState` — still prints to stderr via the
  // sink's own fallback (a refused owned write never disappears in
  // silence, #135) AND records the same warning in `operator_notices`.
  const store = productionOwnershipStore(connection.database, {
    warning: toolBase.noticesSink.warnState,
  });
  ownershipRef.store = store;
  const workflowService = new WorkflowService({
    runtime: new OrchestrationChildRuntime(orchestrationCore),
    environment: options.environment,
    homeRoot: options.home,
    store,
    auditTrail: new AuditTrail(toolBase.auditRepository, {
      warning: toolBase.noticesSink.warn,
    }),
    // Issue #401: unifies this process's `WorkflowService`-level warnings
    // (`this.warn` inside `service.ts`) into the same sink.
    onWarning: toolBase.noticesSink.warn,
    onLiveEvent: (event) => {
      liveTail.push(event);
    },
  });
  const visionRunner = createModelTransport();
  const sessionTools = composeSessionTools({
    base: toolBase,
    home: options.home,
    cwd: options.cwd,
    environment: options.environment,
    sessions,
    workflowService,
    orchestrationHandlers: orchestrationToolHandlers(orchestrationCore, clientPool),
    visionRunner,
    ...(imageGenerator === undefined ? {} : { imageGenerator }),
    visionModel: model,
    imageModel: model,
    supportsVision: profile.supportsVision,
  });
  // `composeSessionTools` (`session-tools.ts:93`, outside this issue's
  // Files) wires `workflow_status` tail-less — this second, narrower
  // override is the one call that actually threads `liveTail` into the
  // tool surface, same registry, same generation bump.
  sessionTools.registry.overrideHandlers({
    workflow_status: workflowStatusHandler(workflowService, liveTail),
  });
  const toolRuntime = createGatewayToolRuntime(options.home, sessionTools.registry);
  const cronStore = new CronStore(options.home);
  cronStore.list();
  let schedulerStopped = false;
  let wakeScheduler: (() => void) | undefined;
  const schedulerLoop = runSchedulerLoop({
    store: cronStore,
    stop: { isSet: () => schedulerStopped },
    wait: (milliseconds) =>
      new Promise<void>((resolveWait) => {
        if (schedulerStopped) {
          resolveWait();
          return;
        }
        const timer = setTimeout(resolveWait, milliseconds);
        wakeScheduler = () => {
          clearTimeout(timer);
          resolveWait();
        };
      }),
    runJob: async (job) => {
      const transport = createModelTransport();
      try {
        const runtime = new ConversationRuntime({
          repository: new SqliteConversationRepository(sessions),
          transport,
          promptSnapshot: () => systemPrompt,
          toolDefinitions: sessionTools.toolDefinitions,
          toolDispatcher: new RegistryToolDispatcher(sessionTools.dispatch),
          idSource: () => randomUUID().replaceAll("-", ""),
          clock: () => Date.now() / 1_000,
          maxTokens: profile.defaultMaxTokens,
          pricingOverrides,
        });
        await runtime.runTurn({
          input: job.prompt,
          provider: providerName,
          model,
          cwd: options.cwd,
        });
      } finally {
        await transport.close();
      }
    },
  });

  // Issue #428: `reason` defaults to "operator" (the bind-failure path
  // below never signals) — the shutdown-trigger path is the only caller
  // that passes "signal", so `segment.completed` can tell the two apart.
  const closeResources = async (reason: "signal" | "operator" = "operator"): Promise<void> => {
    schedulerStopped = true;
    wakeScheduler?.();
    await schedulerLoop;
    await orchestrationCore.shutdown(options.home);
    await mcpManager?.shutdown();
    await visionRunner.close();
    await imageGenerator?.close();
    // WorkflowService.shutdown() BEFORE connection.close() (#102): a durable
    // run's own completion handler releases its lease and writes its
    // terminal line while the connection is still open, instead of racing
    // this close and failing later against a closed one.
    await workflowService.shutdown(reason);
    connection.close();
  };

  const routeContext: RouteContext = {
    expectedToken: token,
    authRequired: !insecure,
    handlers: {
      status: () => ({ ok: true, version: GATEWAY_VERSION, sessions: registry.list().length }),
      sessions: () => ({ sessions: registry.list() }),
      messages: (sessionId) => ({ messages: registry.history(sessionId) }),
      config: () => ({ version: GATEWAY_VERSION, auth_required: !insecure }),
    },
  };

  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired: !insecure, expectedToken: token },
    sessionDefaults: { model, systemPrompt, cwd: options.cwd },
    toolNames: toolRuntime.toolNames,
    toolDefinitions: toolRuntime.toolDefinitions,
    home: options.home,
    provider: providerName,
    createModelTransport,
    createConversationRepository: () => new SqliteConversationRepository(sessions),
    dispatchTool: toolRuntime.dispatch,
  });

  // Mirrors the oracle's `dashboard --port <n>` flag (T12 baseline harness's
  // dash_launcher.py passes --port explicitly for hermetic testing).
  // options.port stays available for programmatic/test injection and wins
  // over the parsed --port flag when both are present.
  const flagPort = stringFlag(options.flags, "--port");
  const requestedPort = options.port ?? (flagPort === undefined ? DEFAULT_PORT : Number(flagPort));
  const displayHost = formatHostForUrl(host);
  const printBootLines = (port: number): void => {
    options.stderr(`Lohra dashboard: http://${displayHost}:${String(port)}\n`);
    options.stderr(
      insecure
        ? `WebSocket:       ws://${displayHost}:${String(port)}/api/ws\n`
        : `WebSocket:       ws://${displayHost}:${String(port)}/api/ws?token=${token}\n`,
    );
  };

  // The oracle prints its boot lines (including the WS token) BEFORE the
  // bind actually completes -- a port-busy failure still shows the token
  // line on stderr first (assertion 55). Reproduced by printing ahead of
  // listen() whenever a concrete port is requested. Ephemeral requests
  // (port 0, used by tests that don't care about this ordering and need
  // the real assigned port to build client URLs) print after binding
  // instead, since there is nothing meaningful to announce in advance.
  if (requestedPort !== 0) printBootLines(requestedPort);

  let server;
  try {
    server = await startGatewayHttpServer({
      host,
      port: requestedPort,
      onRequest: (request) => Promise.resolve(routeGatewayRequest(request.head, routeContext)),
      onUpgrade,
    });
  } catch (error) {
    await closeResources();
    if (isAddressInUse(error)) return 3;
    throw error;
  }

  if (requestedPort === 0) printBootLines(server.port);

  return new Promise<number>((resolvePromise) => {
    const shutdown = (): void => {
      void server.close().finally(() => {
        void closeResources("signal").finally(() => {
          resolvePromise(0);
        });
      });
    };
    // Issue #428: the real (non-injected) default now covers SIGTERM too,
    // not just SIGINT — `registerShutdownTrigger` (`src/cli/`).
    (options.registerShutdownTrigger ?? registerShutdownTrigger)(shutdown);
  });
}
