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
  ResponsesClient,
} from "../transports/index.js";
import type { ModelTransport } from "../conversation/index.js";
import { formatProviderFailureMessage } from "../serialization/provider-error-message.js";
import { runChatBoundary } from "./chat-boundary.js";
import { CHAT_TOOL_REGISTRY_FACTORIES } from "./chat-tools.js";
import { composeSessionTools, createSessionToolBase } from "./session-tools.js";
import { OrchestrationChildRuntime, WorkflowService } from "../workflow/index.js";

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
  if (provider === undefined && route.mode !== "subscription")
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });

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
  let subscriptionNote = "";
  let model: string | undefined;
  let imageGenerator: OpenAIImagesAdapter | undefined;
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
    model = stringFlag(options.flags, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
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
        NO_PROVIDER_CONFIGURED_SHORT,
        `unknown provider '${String(provider).toLowerCase()}' (known: ${knownProviderNames().join(", ")})`,
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
  const sessionToolBase = createSessionToolBase(connection.database, options.environment);
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
  const workflowService = new WorkflowService({
    runtime: new OrchestrationChildRuntime(orchestrationCore),
    environment: options.environment,
    homeRoot: options.home,
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
  const runtime = new ConversationRuntime({
    repository,
    transport: modelTransport,
    promptSnapshot: snapshot,
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
    const result = await runtime.runTurn({
      input,
      provider: profile.name,
      model,
      temperature,
      cwd: options.cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return {
      code: 0,
      stdout: options.flags.has("--json")
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
    // Children may dispatch MCP tools through the parent registry, so their
    // turns must settle before the MCP sessions are closed.
    if (mcpManager !== null) await mcpManager.shutdown();
    await imageGenerator?.close();
    connection.close();
  }
}
