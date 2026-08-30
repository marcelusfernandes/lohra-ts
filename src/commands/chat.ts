import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectContext, buildSystemPrompt } from "../context/index.js";
import {
  ChatCompletionsModel,
  ConversationError,
  ConversationRuntime,
  errorEnvelope,
  IncompleteToolCallError,
  MaxIterationsError,
  SqliteConversationRepository,
  successEnvelope,
} from "../conversation/index.js";
import { loadSoul, MemoryStore } from "../memory/index.js";
import { loadPriceOverrides } from "../pricing/index.js";
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
  createChatCompletionsClient,
  ProviderCallFailed,
  resolveChatCompletionsTarget,
} from "../transports/index.js";
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

function pythonRepr(value: unknown): string {
  if (value === null) return "None";
  if (value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string")
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${pythonRepr(key)}: ${pythonRepr(entry)}`)
      .join(", ")}}`;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return value.name;
  return "None";
}

function publicError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ProviderCallFailed && cause.statusCode !== undefined) {
    return `Error code: ${String(cause.statusCode)} - ${pythonRepr(cause.payload)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runChat(options: ChatCommandOptions): Promise<Result> {
  const input = prompt(options.argv);
  const provider = option(options.argv, "--provider");
  if (provider === undefined)
    return runChatBoundary({ home: options.home, codexHome: options.codexHome, input });
  const target = resolveChatCompletionsTarget(provider, options.environment);
  const model = option(options.argv, "--model") ?? target.profile.fallbackModels[0];
  if (model === undefined) {
    const message = `provider '${target.profile.name}' has no default model — pass --model.`;
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
  const client = createChatCompletionsClient(target.profile.name, options.environment);
  const runtime = new ConversationRuntime({
    repository,
    transport: new ChatCompletionsModel(client),
    promptSnapshot: snapshot,
    ...(useTools
      ? {
          toolDefinitions: builtinRegistry.getDefinitions(),
          toolDispatcher: new RegistryToolDispatcher(dispatch),
        }
      : {}),
    idSource: () => randomUUID().replaceAll("-", ""),
    clock: () => Date.now() / 1000,
    maxTokens: target.profile.defaultMaxTokens,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    pricingOverrides: loadPriceOverrides(join(options.home, "pricing.json")),
  });
  try {
    const result = await runtime.runTurn({
      input,
      provider: target.profile.name,
      model,
      cwd: options.cwd,
      temperature,
      ...(option(options.argv, "--session") === undefined
        ? {}
        : { sessionId: option(options.argv, "--session") as string }),
    });
    return {
      code: 0,
      stdout: successEnvelope(result),
      stderr: `session: ${result.sessionId}  (resume with --session ${result.sessionId})\n`,
    };
  } catch (error) {
    const message = publicError(error);
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
              cost: (incomplete ?? bounded)?.cost ?? null,
              sessionSummary: (incomplete ?? bounded)?.sessionSummary ?? null,
              ...(bounded === null
                ? {}
                : { stopReason: "tool_calls", toolCalls: bounded.toolCalls }),
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
