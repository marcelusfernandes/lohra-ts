// Issue #604: `runChat` (e `runDashboard`, mesma fronteira) mandavam TODA
// invocação sem `--provider` fora do modo `subscription` direto para
// `runChatBoundary` ("no provider configured"), sem consultar as chaves que
// `doctor` já reporta como `usable` (`src/doctor/snapshot.ts:127-130`).
// `detectChatProvider` (`src/commands/provider-detectado.ts`) fecha essa
// lacuna reusando a MESMA regra que `doctor` usa para `detected_provider`
// (`src/doctor/providers.ts`'s `detectConfiguredProvider`, por sua vez só
// `resolveProviderName` — nenhuma tabela de provedores nova).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { detectChatProvider } from "../src/commands/provider-detectado.js";
import { registerProvider } from "../src/providers/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-t604-provider-detectado-"));
  roots.push(value);
  return value;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

function chatCompletion(text: string): Readonly<Record<string, unknown>> {
  return {
    id: "chatcmpl-t604",
    object: "chat.completion",
    created: 0,
    model: "t604-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/** Um único turno sem tool call: qualquer requisição recebida responde com
 * texto puro (formato Chat Completions, como `tests/chat-audit-trail-wiring
 * .test.ts` já usa para esse mesmo apiMode) e conta as chamadas recebidas. */
function startServer(): { server: Server; calls: () => number } {
  let calls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls += 1;
      const text = JSON.stringify(chatCompletion("ok"));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
  return { server, calls: () => calls };
}

function envelopeOf(stdout: string): {
  error: string | null;
  model: string | null;
  api_calls: number;
  completed: boolean;
} {
  return JSON.parse(stdout) as {
    error: string | null;
    model: string | null;
    api_calls: number;
    completed: boolean;
  };
}

describe("detectChatProvider (issue #604): mesma regra de detected_provider do doctor", () => {
  it("sem nenhuma variável configurada, devolve provider: null, detail: null", () => {
    expect(detectChatProvider({})).toEqual({ provider: null, detail: null });
  });

  it("com ANTHROPIC_API_KEY presente, detecta 'anthropic'", () => {
    expect(detectChatProvider({ ANTHROPIC_API_KEY: "sk-fake" })).toEqual({
      provider: "anthropic",
      detail: null,
    });
  });

  it("LOHRA_PROVIDER explícito no ambiente tem precedência sobre as chaves", () => {
    expect(
      detectChatProvider({
        LOHRA_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "sk-fake",
        ANTHROPIC_API_KEY: "sk-fake-2",
      }),
    ).toEqual({ provider: "openrouter", detail: null });
  });

  it("com duas chaves presentes, a primeira na ordem do doctor vence (anthropic antes de openai)", () => {
    expect(
      detectChatProvider({ OPENAI_API_KEY: "sk-fake", ANTHROPIC_API_KEY: "sk-fake-2" }),
    ).toEqual({ provider: "anthropic", detail: null });
  });

  it("LOHRA_PROVIDER apontando para um nome desconhecido vira 'detail', nunca engolido em silêncio", () => {
    const result = detectChatProvider({ LOHRA_PROVIDER: "bogus-t604" });
    expect(result.provider).toBeNull();
    expect(result.detail).toContain("unknown provider 'bogus-t604'");
  });
});

describe("runChat sem --provider usa o provedor detectado na rota api_key (issue #604)", () => {
  it("home com uma chave fictícia e stub local: error null, api_calls >= 1, completed true", async () => {
    const { server, calls } = startServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const home = root();
      const provider = "t604-detectado-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T604 detected provider probe",
        description: "Local stub standing in for a real API-key provider (issue #604).",
        signupUrl: "",
        envVars: ["T604_DETECTADO_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t604-detectado-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const result = await runChat({
        input: "oi",
        // No `--provider`: the point of this issue is that this alone must
        // no longer fall to the "no provider configured" boundary.
        flags: new Map<string, string | true>([
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: {
          HOME: home,
          PATH: process.env.PATH ?? "",
          T604_DETECTADO_KEY: "test-key",
        },
        home: join(home, ".lohra"),
        codexHome: join(home, ".codex"),
        cwd: home,
      });

      expect(envelopeOf(result.stdout).error).toBeNull();
      expect(result.code).toBe(0);
      expect(envelopeOf(result.stdout).completed).toBe(true);
      expect(calls()).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(server);
    }
  });

  it("--provider explícito continua tendo precedência sobre a detecção (issue #604 AC 3)", async () => {
    const { server, calls } = startServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const otherServer = createServer((_request, response) => {
      response.writeHead(500);
      response.end("t604: this provider must never be reached when --provider names another one");
    });
    await new Promise<void>((resolvePromise) => otherServer.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      const otherAddress = otherServer.address();
      if (
        address === null ||
        typeof address === "string" ||
        otherAddress === null ||
        typeof otherAddress === "string"
      )
        throw new Error("missing test port");
      const home = root();
      // Registered FIRST in `resolveProviderName`'s scan order (registration
      // order) and its env var is the one set below -- auto-detection alone
      // would pick this one.
      registerProvider({
        name: "t604-detected-but-unwanted",
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T604 would-be-detected probe",
        description: "Must be skipped: --provider names the other probe explicitly.",
        signupUrl: "",
        envVars: ["T604_UNWANTED_KEY"],
        baseUrl: `http://127.0.0.1:${String(otherAddress.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t604-unwanted-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const explicitProvider = "t604-explicit-probe";
      registerProvider({
        name: explicitProvider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T604 explicit probe",
        description: "Named explicitly via --provider; must be the one actually reached.",
        signupUrl: "",
        envVars: ["T604_EXPLICIT_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t604-explicit-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const result = await runChat({
        input: "oi",
        flags: new Map<string, string | true>([
          ["--provider", explicitProvider],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: {
          HOME: home,
          PATH: process.env.PATH ?? "",
          T604_UNWANTED_KEY: "test-key-unwanted",
          T604_EXPLICIT_KEY: "test-key-explicit",
        },
        home: join(home, ".lohra"),
        codexHome: join(home, ".codex"),
        cwd: home,
      });

      expect(result.code).toBe(0);
      expect(envelopeOf(result.stdout).error).toBeNull();
      expect(calls()).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(server);
      await closeServer(otherServer);
    }
  });

  it("LOHRA_PROVIDER inválido devolve initializationError citando o nome, não a fronteira genérica (issue #604)", async () => {
    const home = root();
    const result = await runChat({
      input: "oi",
      flags: new Map<string, string | true>([
        ["--json", true],
        ["--no-input", true],
        ["--no-tools", true],
      ]),
      environment: { HOME: home, LOHRA_PROVIDER: "bogus-t604" },
      home: join(home, ".lohra"),
      codexHome: join(home, ".codex"),
      cwd: home,
    });
    expect(result.code).toBe(2);
    // Same shape the explicit-`--provider bogus` case already uses
    // (chat.ts): a generic short message on stdout, the actual unknown-name
    // detail on stderr only.
    const envelope = envelopeOf(result.stdout);
    expect(envelope.error).toBe(
      "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
    );
    expect(result.stderr).toContain("unknown provider 'bogus-t604'");
  });

  it("home vazio continua devolvendo o envelope 'no provider configured' byte-igual (issue #604 AC 2, pino)", async () => {
    const home = root();
    const result = await runChat({
      input: "oi",
      flags: new Map<string, string | true>([
        ["--json", true],
        ["--no-input", true],
      ]),
      environment: { HOME: home },
      home: join(home, ".lohra"),
      codexHome: join(home, ".codex"),
      cwd: home,
    });
    expect(result.code).toBe(2);
    const envelope = envelopeOf(result.stdout);
    expect(envelope.error).toBe(
      "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
    );
  });
});
