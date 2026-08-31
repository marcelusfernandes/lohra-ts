import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectContext, buildSystemPrompt } from "../context/index.js";
import { readCodexModel } from "../auth/codex.js";
import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
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
import { loadSoul, MemoryStore } from "../memory/index.js";
import { buildOrchestrationCore, orchestrationToolHandlers } from "../orchestration/chat-wiring.js";
import { resolveFanout } from "../orchestration/fanout-config.js";
import { loadPriceOverrides } from "../pricing/index.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  resolveApiKey,
  type ProviderProfile,
} from "../providers/index.js";
import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";
import { openStateForEnvironment, SessionRepository } from "../state/index.js";
import { SkillStore } from "../skills/index.js";
import {
  approval,
  builtinRegistry,
  composeDispatch,
  ListModelsTool,
  MemoryTool,
  RegistryToolDispatcher,
  SessionSearchTool,
  SkillTool,
} from "../tools/index.js";
import {
  AnthropicMessagesClient,
  buildClient,
  ChatCompletionsClient,
  createResponsesClient,
  ResponsesClient,
} from "../transports/index.js";
import type { ModelTransport } from "../conversation/index.js";
import { formatProviderFailureMessage } from "../serialization/provider-error-message.js";
import { runChatBoundary } from "./chat-boundary.js";

export interface ChatCommandOptions {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly codexHome: string;
  readonly cwd: string;
}

type Result = Readonly<{ code: number; stdout: string; stderr: string }>;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function prompt(argv: readonly string[]): string {
  const takesValue = new Set([
    "--provider",
    "--model",
    "--session",
    "--temperature",
    "--max-iterations",
    "--max-parallel",
    "--profile",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (takesValue.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) return value;
  }
  return "";
}

function finite(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`CHAT_OPTION_INVALID:${name}`);
  return result;
}

function initializationError(input: string, model: string | null, message: string): Result {
  return {
    code: 2,
    stdout: `${pythonJsonDumpsInsertionOrder({
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
    stderr: `${message}\n`,
  };
}

export async function runChat(options: ChatCommandOptions): Promise<Result> {
  const input = prompt(options.argv);
  const provider = option(options.argv, "--provider");
  const route = resolveAuthRoute(options.home);
  if (route.error)
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
  if (provider === undefined && route.mode !== "subscription")
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });

  // Minted up front so it's known before ClientPool/OrchestrationCore/
  // createChildRunner are constructed below (parent_session_id is fixed at
  // their construction time, L21) — idSource is wired to return this same
  // value later, so runTurn ends up with an identical sessionId either way,
  // whether --session was given or not.
  const parentSessionId = option(options.argv, "--session") ?? randomUUID().replaceAll("-", "");

  let profile: ProviderProfile;
  let client: ChatCompletionsClient | AnthropicMessagesClient | ResponsesClient;
  let modelTransport: ModelTransport;
  let subscriptionNote = "";
  let model: string | undefined;
  if (route.mode === "subscription") {
    let credentials;
    try {
      credentials = await resolveCredentials(options.home, { codexHome: options.codexHome });
    } catch {
      return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
    }
    if (credentials === null)
      return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
    profile = CODEX_PROVIDER;
    model = option(options.argv, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
    client = createResponsesClient({
      baseUrl: credentials.baseUrl,
      token: credentials.token,
      accountId: credentials.accountId,
      headers: credentials.headers,
    });
    modelTransport = new ResponsesModel(client);
    if (provider !== undefined)
      subscriptionNote = `subscription mode active — ignoring --provider ${provider}.\n`;
  } else {
    const resolved = getProviderProfile(provider as string);
    if (resolved === null)
      return initializationError(
        input,
        null,
        `unknown provider '${String(provider).toLowerCase()}'`,
      );
    profile = resolved;
    model = option(options.argv, "--model") ?? profile.fallbackModels[0];
    const key = resolveApiKey(profile.name, options.environment);
    if (profile.apiMode === "chat_completions" && key === null && profile.requiresApiKey) {
      const message =
        `could not initialize the ${profile.name} client: Missing credentials. ` +
        "Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.";
      return initializationError(input, model ?? null, message);
    }
    client = buildClient(profile, key ?? (profile.name === "ollama" ? "lohra-local" : ""));
    const streaming = !options.argv.includes("--json");
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
  const temperature = finite(option(options.argv, "--temperature"), "temperature") ?? null;
  const maxIterations = finite(option(options.argv, "--max-iterations"), "max-iterations");
  const fanout = resolveFanout(
    option(options.argv, "--max-parallel"),
    maxIterations,
    options.environment,
  );
  const warningLines = fanout.warnings.map((warning) => `${warning}\n`).join("");
  const connection = openStateForEnvironment(options.environment);
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const repository = new SqliteConversationRepository(sessions);
  const useTools = !options.argv.includes("--no-tools");
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
  const snapshot = (): string => {
    const context = loadProjectContext(options.cwd);
    const identity = loadSoul(options.home);
    const memory = useTools ? memoryStore.snapshot() : null;
    return buildSystemPrompt({
      ...(identity === undefined ? {} : { identity }),
      contextFiles: context.instructions,
      environmentHints: context.hints,
      ...(memory === null || !memory.memory ? {} : { memorySnapshot: memory.memory }),
      ...(memory === null || !memory.user ? {} : { userProfile: memory.user }),
      ...(useTools ? { skillsIndex: skillStore.snapshot() } : {}),
    }).text;
  };
  approval.reset();
  approval.setYolo(options.argv.includes("--yolo"));
  approval.setCallback(
    options.argv.includes("--json") || options.argv.includes("--no-input") ? () => "deny" : null,
  );
  const baseDispatch = builtinRegistry.dispatch.bind(builtinRegistry);
  const memoryTool = new MemoryTool(memoryStore);
  const skillTool = new SkillTool(skillStore);
  const listModels = new ListModelsTool(options.home, options.environment);
  const clientPool = new ClientPool(profile, client, {
    home: options.home,
    codexHome: options.codexHome,
    environment: options.environment,
  });
  const orchestrationCore = buildOrchestrationCore({
    fanout,
    sessions,
    parentSessionId,
    clientPool,
    baseDispatch,
    parentToolDefinitions: builtinRegistry.getDefinitions(),
    defaultModel: model,
    cwd: options.cwd,
  });
  const dispatch = composeDispatch(baseDispatch, {
    memory: (args) => memoryTool.handle(args),
    skill_view: (args) => skillTool.view(args),
    skill_manage: (args) => skillTool.manage(args),
    session_search: (args) => new SessionSearchTool(sessions).handle(args),
    list_models: (args) => listModels.handle(args),
    ...orchestrationToolHandlers(orchestrationCore, clientPool),
  });
  const runtime = new ConversationRuntime({
    repository,
    transport: modelTransport,
    promptSnapshot: snapshot,
    ...(useTools
      ? {
          toolDefinitions: builtinRegistry.getDefinitions(),
          toolDispatcher: new RegistryToolDispatcher(dispatch),
        }
      : {}),
    idSource: () => parentSessionId,
    clock: () => Date.now() / 1000,
    maxTokens: profile.defaultMaxTokens,
    maxIterations: fanout.parentMaxIterations,
    pricingOverrides: loadPriceOverrides(join(options.home, "pricing.json")),
  });
  try {
    const result = await runtime.runTurn({
      input,
      provider: profile.name,
      model,
      cwd: options.cwd,
      temperature,
      ...(option(options.argv, "--session") === undefined
        ? {}
        : { sessionId: option(options.argv, "--session") as string }),
    });
    return {
      code: 0,
      stdout: options.argv.includes("--json")
        ? successEnvelope(result)
        : `${result.response.content ?? ""}\n`,
      stderr: `${warningLines}${subscriptionNote}session: ${result.sessionId}  (resume with --session ${result.sessionId})\n`,
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
      stderr: `${warningLines}${sessionId ? `session: ${sessionId}  (resume with --session ${sessionId})\n` : ""}error: ${message}\n`,
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
    connection.close();
  }
}
