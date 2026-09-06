import { generateSessionToken } from "../gateway/auth.js";
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
  WorkflowService,
} from "../workflow/index.js";
import { composeSessionTools, createSessionToolBase } from "./session-tools.js";
import { CronStore } from "../cron/store.js";
import { runSchedulerLoop } from "../cron/scheduler.js";
import { RegistryToolDispatcher } from "../tools/index.js";

const GATEWAY_VERSION = "0.0.11";
const DEFAULT_PORT = 9119;

export interface DashboardCommandOptions {
  readonly argv: readonly string[];
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

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

export async function runDashboard(options: DashboardCommandOptions): Promise<number> {
  const insecure = options.argv.includes("--insecure");
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
    model = option(options.argv, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
    providerName = "codex";
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
    const provider = option(options.argv, "--provider");
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
    model = option(options.argv, "--model") ?? profile.fallbackModels[0] ?? "unknown";
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

  const token = options.environment.LOHRA_DASHBOARD_SESSION_TOKEN ?? generateSessionToken();
  const context = loadProjectContext(options.cwd);
  const systemPrompt = buildSystemPrompt({
    contextFiles: context.instructions,
    environmentHints: context.hints,
  }).text;

  const connection = openStateForEnvironment(options.environment);
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const toolBase = createSessionToolBase(connection.database, options.environment);
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
  const workflowService = new WorkflowService({
    runtime: new OrchestrationChildRuntime(orchestrationCore),
    environment: options.environment,
    homeRoot: options.home,
    // Durable by default: the store is built over THIS root's own
    // connection.database (#101), never a second one, and the leaf sandbox
    // OrchestrationChildRuntime now installs (#107) is what lets its runs
    // actually spawn tool-using leaves instead of denying them fail-closed.
    store: productionOwnershipStore(connection.database),
    auditTrail: new AuditTrail(toolBase.auditRepository),
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

  const closeResources = async (): Promise<void> => {
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
    await workflowService.shutdown();
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
  // over argv when both are present.
  const argvPort = option(options.argv, "--port");
  const requestedPort = options.port ?? (argvPort === undefined ? DEFAULT_PORT : Number(argvPort));
  const printBootLines = (port: number): void => {
    options.stderr(`Lohra dashboard: http://127.0.0.1:${String(port)}\n`);
    options.stderr(
      insecure
        ? `WebSocket:       ws://127.0.0.1:${String(port)}/api/ws\n`
        : `WebSocket:       ws://127.0.0.1:${String(port)}/api/ws?token=${token}\n`,
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
      host: "127.0.0.1",
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
        void closeResources().finally(() => {
          resolvePromise(0);
        });
      });
    };
    (options.registerShutdownTrigger ?? ((handler) => process.once("SIGINT", handler)))(shutdown);
  });
}
