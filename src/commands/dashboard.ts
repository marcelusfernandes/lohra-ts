import { generateSessionToken } from "../gateway/auth.js";
import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
import { readCodexModel } from "../auth/codex.js";
import { getProviderProfile, resolveApiKey } from "../providers/index.js";
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
  ResponsesModel,
  SqliteConversationRepository,
} from "../conversation/index.js";
import type { ModelTransport } from "../conversation/types.js";
import { AnthropicMessagesClient, buildClient, createResponsesClient } from "../transports/index.js";

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
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE";
}

export async function runDashboard(options: DashboardCommandOptions): Promise<number> {
  const insecure = options.argv.includes("--insecure");
  const route = resolveAuthRoute(options.home);

  let model: string;
  let providerName: string;
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
    createModelTransport = () =>
      new ResponsesModel(
        createResponsesClient({
          baseUrl: credentials.baseUrl,
          token: credentials.token,
          accountId: credentials.accountId,
          headers: credentials.headers,
        }),
        true,
      );
  } else {
    const provider = option(options.argv, "--provider");
    if (provider === undefined) {
      options.stderr(noProvider);
      return 2;
    }
    const profile = getProviderProfile(provider);
    if (profile === null) {
      options.stderr(`unknown provider '${provider.toLowerCase()}'\n`);
      return 2;
    }
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
    if (route.note !== undefined) options.stderr(`${route.note}\n`);
    // Fresh client + transport per turn, streaming:true (this gateway's own
    // layer decides to stream -- onDelta alone does nothing, see the
    // provisional seam commit) -- matches "cada request cria Agent novo".
    createModelTransport = () => {
      const client = buildClient(profile, key ?? (profile.name === "ollama" ? "lohra-local" : ""));
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
  const toolRuntime = createGatewayToolRuntime(options.home);

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

  const requestedPort = options.port ?? DEFAULT_PORT;
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
    connection.close();
    if (isAddressInUse(error)) return 3;
    throw error;
  }

  if (requestedPort === 0) printBootLines(server.port);

  return new Promise<number>((resolvePromise) => {
    const shutdown = (): void => {
      void server.close().finally(() => {
        connection.close();
        resolvePromise(0);
      });
    };
    (options.registerShutdownTrigger ?? ((handler) => process.once("SIGINT", handler)))(shutdown);
  });
}
