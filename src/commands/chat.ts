import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectContext, buildSystemPrompt } from "../context/index.js";
import { readCodexModel } from "../auth/codex.js";
import { resolveAuthRoute, resolveCredentials } from "../auth/credentials.js";
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
import { loadPriceOverrides } from "../pricing/index.js";
import {
  CODEX_PROVIDER,
  getProviderProfile,
  knownProviderNames,
  resolveApiKey,
  type ProviderProfile,
} from "../providers/index.js";
import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";
import { openStateForEnvironment, SessionRepository } from "../state/index.js";
import { SkillStore } from "../skills/index.js";
import {
  approval,
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
  createResponsesClient,
  publicCauseMessage,
} from "../transports/index.js";
import type { ModelTransport } from "../conversation/index.js";
import { runChatBoundary } from "./chat-boundary.js";
import { CHAT_TOOL_REGISTRY_FACTORIES } from "./chat-tools.js";

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

  let profile: ProviderProfile;
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
    model = stringFlag(options.flags, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
    modelTransport = new ResponsesModel(
      createResponsesClient({
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        accountId: credentials.accountId,
        headers: credentials.headers,
      }),
    );
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
    profile = resolved;
    model = stringFlag(options.flags, "--model") ?? profile.fallbackModels[0];
    const key = resolveApiKey(profile.name, options.environment);
    if (profile.apiMode === "chat_completions" && key === null && profile.requiresApiKey) {
      const message =
        `could not initialize the ${profile.name} client: Missing credentials. ` +
        "Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.";
      return initializationError(input, model ?? null, message);
    }
    const client = buildClient(profile, key ?? (profile.name === "ollama" ? "lohra-local" : ""));
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
  const maxIterations = finite(stringFlag(options.flags, "--max-iterations"), "max-iterations");
  const connection = openStateForEnvironment(options.environment);
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const sessionRegistry = createChatSessionRegistry(connection.database, options.environment);
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
  const baseDispatch = sessionRegistry.dispatch.bind(sessionRegistry);
  const memoryTool = new MemoryTool(memoryStore);
  const skillTool = new SkillTool(skillStore);
  const listModels = new ListModelsTool(options.home, options.environment);
  const dispatch = composeDispatch(baseDispatch, {
    memory: (args) => memoryTool.handle(args),
    skill_view: (args) => skillTool.view(args),
    skill_manage: (args) => skillTool.manage(args),
    session_search: (args) => new SessionSearchTool(sessions).handle(args),
    list_models: (args) => listModels.handle(args),
  });
  const runtime = new ConversationRuntime({
    repository,
    transport: modelTransport,
    promptSnapshot: snapshot,
    ...(useTools
      ? {
          toolDefinitions: sessionRegistry.getDefinitions(),
          toolDispatcher: new RegistryToolDispatcher(dispatch),
        }
      : {}),
    idSource: () => randomUUID().replaceAll("-", ""),
    clock: () => Date.now() / 1000,
    maxTokens: profile.defaultMaxTokens,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    pricingOverrides: loadPriceOverrides(join(options.home, "pricing.json")),
  });
  try {
    const sessionId = stringFlag(options.flags, "--session");
    const result = await runtime.runTurn({
      input,
      provider: profile.name,
      model,
      cwd: options.cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return {
      code: 0,
      stdout: options.flags.has("--json")
        ? successEnvelope(result)
        : `${result.response.content ?? ""}\n`,
      stderr: `${subscriptionNote}session: ${result.sessionId}  (resume with --session ${result.sessionId})\n`,
    };
  } catch (error) {
    const message = publicCauseMessage(error);
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
      stderr: `${sessionId ? `session: ${sessionId}  (resume with --session ${sessionId})\n` : ""}error: ${message}\n`,
    };
  } finally {
    approval.setCallback(null);
    approval.setYolo(false);
    approval.reset();
    connection.close();
  }
}
