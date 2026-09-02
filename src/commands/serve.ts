/** `lohra serve` — mirrors `run_openai_server`/`build_openai_server_app` in
 * lohra/cli.py. Resolves a provider the same way `doctor`/`init` auto-detect
 * one (no --provider flag exists on this command, matching the oracle),
 * builds ONE shared provider client for the process lifetime, and blocks
 * until SIGINT or a startup failure. The subscription/ToS-risk gate lives in
 * cli.ts, ahead of this function — it must never be bypassed by anything
 * added here. */

import { randomBytes } from "node:crypto";

import { buildSystemPrompt } from "../context/index.js";
import {
  AGENTIC_MAX_ITERATIONS,
  buildAllowedTools,
  RELAY_MAX_ITERATIONS,
} from "../server/agentic.js";
import { createOpenAiServer } from "../server/http-app.js";
import { CompletionService } from "../server/service.js";
import {
  AUTO_PROVIDER,
  getProviderProfile,
  resolveApiKey,
  resolveProviderName,
} from "../providers/index.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  type ToolDispatcher,
} from "../conversation/index.js";
import { AnthropicMessagesClient, buildClient } from "../transports/index.js";

export interface ServeCommandOptions {
  readonly configuration: ServeConfiguration;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

/** Canonical, immutable projection of cli.ts's single ParseResult. runServe
 * deliberately cannot see raw argv: accepted abbreviations and inline forms
 * have already been normalized to their canonical option names by the shared
 * parser before this boundary. */
export interface ServeConfiguration {
  readonly host: string;
  readonly port: number;
  readonly insecure: boolean;
  readonly tools: string;
}

export async function runServe(options: ServeCommandOptions): Promise<number> {
  const { host, port, insecure, tools: toolsArg } = options.configuration;

  const providerName = resolveProviderName(undefined, undefined, options.environment);
  if (providerName === AUTO_PROVIDER) {
    options.stderr(
      "no provider configured — set an API key env var (e.g. ANTHROPIC_API_KEY, " +
        "OPENAI_API_KEY), run `ollama serve`, or set LOHRA_PROVIDER.\n",
    );
    return 2;
  }
  const profile = getProviderProfile(providerName);
  if (profile === null) {
    options.stderr(`unknown provider '${providerName}'.\n`);
    return 2;
  }
  if (profile.apiMode !== "chat_completions" && profile.apiMode !== "anthropic_messages") {
    options.stderr(
      `provider '${profile.name}' (api_mode '${profile.apiMode}') is not supported yet.\n`,
    );
    return 2;
  }

  const upstreamKey =
    resolveApiKey(profile.name, options.environment) ??
    (profile.name === "ollama" ? "lohra-local" : "");
  let client;
  try {
    client = buildClient(profile, upstreamKey);
  } catch (error) {
    options.stderr(
      `could not initialize the ${profile.name} client: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const allowedNames = toolsArg
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  let toolDefinitions: readonly unknown[] | undefined;
  let toolDispatcher: ToolDispatcher | undefined;
  let maxIterations = RELAY_MAX_ITERATIONS;
  if (allowedNames.length > 0) {
    const allowed = buildAllowedTools(allowedNames);
    toolDefinitions = allowed.definitions;
    toolDispatcher = allowed.dispatcher;
    maxIterations = AGENTIC_MAX_ITERATIONS;
    const names = allowed.names.length > 0 ? allowed.names.join(", ") : "(none matched)";
    options.stderr(`⚠️  agentic mode — server-side tools enabled: ${names}\n`);
    options.stderr(
      "    these run with the server's privileges and are NOT sandboxed; " +
        "'terminal'/'write_file' over HTTP are remote code execution.\n",
    );
    if (insecure)
      options.stderr("    ⚠️  --insecure with tools = UNAUTHENTICATED remote code execution.\n");
  }

  const [modelTransport, streamingModelTransport] =
    client instanceof AnthropicMessagesClient
      ? [new AnthropicMessagesModel(client, false), new AnthropicMessagesModel(client, true)]
      : [new ChatCompletionsModel(client, false), new ChatCompletionsModel(client, true)];

  const service = new CompletionService({
    transport: modelTransport,
    streamingTransport: streamingModelTransport,
    systemPrompt: () => buildSystemPrompt().text,
    provider: profile.name,
    maxIterations,
    defaultMaxTokens: profile.defaultMaxTokens,
    ...(toolDispatcher ? { toolDispatcher } : {}),
    ...(toolDefinitions ? { toolDefinitions } : {}),
  });

  const apiKey = insecure
    ? null
    : options.environment.LOHRA_OPENAI_API_KEY?.trim() || randomBytes(24).toString("base64url");

  const server = createOpenAiServer({ service, apiKey, models: profile.fallbackModels });

  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      resolve(code);
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      options.stderr(
        error.code === "EADDRINUSE"
          ? `port ${String(port)} is already in use on ${host}\n`
          : `${error.message}\n`,
      );
      void client.close().finally(() => {
        finish(2);
      });
    });
    const onSigint = (): void => {
      server.closeAllConnections();
      server.close(() => {
        void client.close().finally(() => {
          finish(0);
        });
      });
    };
    process.once("SIGINT", onSigint);
    server.listen(port, host, () => {
      options.stderr(`Lohra OpenAI server: http://${host}:${String(port)}/v1\n`);
      if (apiKey !== null) options.stderr(`API key: ${apiKey}\n`);
    });
  });
}
