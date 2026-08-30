import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { loadProjectContext, buildSystemPrompt } from "../context/index.js";
import {
  ChatCompletionsModel,
  ConversationError,
  ConversationRuntime,
  errorEnvelope,
  IncompleteToolCallError,
  SqliteConversationRepository,
  successEnvelope,
} from "../conversation/index.js";
import { loadSoul } from "../memory/index.js";
import { loadPriceOverrides } from "../pricing/index.js";
import { openStateForEnvironment, SessionRepository } from "../state/index.js";
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
  const snapshot = (): string => {
    const context = loadProjectContext(options.cwd);
    const identity = loadSoul(options.home);
    return buildSystemPrompt({
      ...(identity === undefined ? {} : { identity }),
      contextFiles: context.instructions,
      environmentHints: context.hints,
    }).text;
  };
  const client = createChatCompletionsClient(target.profile.name, options.environment);
  const runtime = new ConversationRuntime({
    repository,
    transport: new ChatCompletionsModel(client),
    promptSnapshot: snapshot,
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
    return {
      code: 1,
      stdout: errorEnvelope({
        sessionId,
        model,
        prompt: input,
        error: message,
        apiCalls,
        ...(incomplete === null
          ? {}
          : {
              usage: incomplete.usage,
              cost: incomplete.cost,
              sessionSummary: incomplete.sessionSummary,
            }),
      }),
      stderr: `${sessionId ? `session: ${sessionId}  (resume with --session ${sessionId})\n` : ""}error: ${message}\n`,
    };
  } finally {
    connection.close();
  }
}
