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
import { CHAT_SPEC } from "../cli/arg-spec.js";
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
  createResponsesClient,
  publicCauseMessage,
} from "../transports/index.js";
import type { ModelTransport } from "../conversation/index.js";
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

// Derived from CHAT_SPEC (src/cli/arg-spec.ts) rather than its own literal
// set, so this can't drift from what cli.ts's validator actually accepts
// the way it once did — that drift is what let `chat --max-parallel 4 hi`
// misread "4" as the prompt (an unknown-to-this-function, known-to-the-
// oracle flag whose value was never skipped).
const CHAT_VALUE_FLAGS = new Set(
  CHAT_SPEC.flags.filter((flag) => flag.takesValue).map((flag) => flag.name),
);

function prompt(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (CHAT_VALUE_FLAGS.has(value)) {
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

export async function runChat(options: ChatCommandOptions): Promise<Result> {
  const input = prompt(options.argv);
  const provider = option(options.argv, "--provider");
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
    model = option(options.argv, "--model") ?? readCodexModel(options.codexHome) ?? "gpt-5.5";
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
    model = option(options.argv, "--model") ?? profile.fallbackModels[0];
    const key = resolveApiKey(profile.name, options.environment);
    if (profile.apiMode === "chat_completions" && key === null && profile.requiresApiKey) {
      const message =
        `could not initialize the ${profile.name} client: Missing credentials. ` +
        "Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.";
      return initializationError(input, model ?? null, message);
    }
    const client = buildClient(profile, key ?? (profile.name === "ollama" ? "lohra-local" : ""));
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
  const maxIterations = finite(option(options.argv, "--max-iterations"), "max-iterations");
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
          toolDefinitions: builtinRegistry.getDefinitions(),
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
    const result = await runtime.runTurn({
      input,
      provider: profile.name,
      model,
      cwd: options.cwd,
      ...(option(options.argv, "--session") === undefined
        ? {}
        : { sessionId: option(options.argv, "--session") as string }),
    });
    return {
      code: 0,
      stdout: options.argv.includes("--json")
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
