// Issue #648 (grupo A, item 7a de #637): a fiação do tier de doutrina
// (`resolveDoctrineTier`/`doctrineText`, `chat.ts:329-331`) nunca foi
// exercitada de ponta a ponta contra um provedor "forte" (não-`ollama`) --
// só a unidade pura em `tests/context-doctrine.test.ts` cobria
// `doctrineText`/`resolveDoctrineTier` isoladamente (veredito PR #610,
// non_blocking 3). Mesmo harness de `tests/chat-compaction-events.test.ts`
// (`runChat` real contra um servidor HTTP local que captura o corpo do
// request) -- aqui capturando o `system` que `chat.ts` realmente manda.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

interface CapturedRequest {
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

/** Same fixed-reply shape `tests/chat-compaction-events.test.ts` uses --
 * content is irrelevant, only that the turn completes and the request body
 * (with the `system` role message `chat.ts` built) is captured. */
function startCapturingServer(captured: CapturedRequest[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      captured.push(body);
      const payload = {
        id: "chatcmpl-t648-doctrine",
        object: "chat.completion",
        created: 0,
        model: "t648-doctrine-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

function systemContentOf(captured: CapturedRequest): string {
  const system = captured.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

async function runProbe(environment: Readonly<Record<string, string | undefined>>): Promise<{
  readonly result: Awaited<ReturnType<typeof runChat>>;
  readonly captured: CapturedRequest[];
}> {
  const root = mkdtempSync(join(tmpdir(), "lohra-t648-chat-doctrine-"));
  roots.push(root);
  const captured: CapturedRequest[] = [];
  const server = startCapturingServer(captured);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    // A registered provider name is NEVER "ollama" -- resolveDoctrineTier's
    // CORE_ONLY_PROVIDERS only special-cases that exact builtin name
    // (src/context/doctrine.ts), so any custom probe name here defaults to
    // "extended", exactly like every other real, hosted provider.
    const provider = `t648-chat-doctrine-probe-${String(Math.random()).slice(2)}`;
    registerProvider({
      name: provider,
      apiMode: "chat_completions",
      aliases: [],
      displayName: "T648 chat doctrine probe",
      description: "Local in-memory composition-root probe (issue #648).",
      signupUrl: "",
      envVars: [],
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      modelsUrl: "",
      requiresApiKey: false,
      supportsVision: false,
      fallbackModels: ["t648-doctrine-model"],
      defaultMaxTokens: 256,
      defaultAuxModel: "",
    });

    const result = await runChat({
      input: "say hi",
      flags: new Map<string, string | true>([
        ["--provider", provider],
        ["--model", "t648-doctrine-model"],
        ["--json", true],
        ["--no-input", true],
        ["--no-tools", true],
      ]),
      environment: { HOME: root, PATH: process.env.PATH ?? "", ...environment },
      home: join(root, ".lohra"),
      codexHome: join(root, ".codex"),
      cwd: root,
    });
    return { result, captured };
  } finally {
    await closeServer(server);
  }
}

describe("chat.ts wires the resolved doctrine tier into the real request (issue #648, #637 item 7a)", () => {
  it("a non-ollama provider defaults to extended: DOCTRINE_EXTENDED's own marker reaches the system message", async () => {
    const { result, captured } = await runProbe({});
    expect(result.code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(systemContentOf(captured[0] as CapturedRequest)).toContain("One idea per sentence");
  });

  it("LOHRA_DOCTRINE=core overrides the extended default: the marker is absent", async () => {
    const { result, captured } = await runProbe({ LOHRA_DOCTRINE: "core" });
    expect(result.code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(systemContentOf(captured[0] as CapturedRequest)).not.toContain("One idea per sentence");
  });

  it("an invalid LOHRA_DOCTRINE fails closed with a named error instead of silently falling back", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t648-chat-doctrine-bad-"));
    roots.push(root);
    const server = startCapturingServer([]);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t648-chat-doctrine-bad-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 chat doctrine bad-value probe",
        description: "Local in-memory composition-root probe (issue #648).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-doctrine-bad-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      await expect(
        runChat({
          input: "say hi",
          flags: new Map<string, string | true>([
            ["--provider", provider],
            ["--model", "t648-doctrine-bad-model"],
            ["--json", true],
            ["--no-input", true],
            ["--no-tools", true],
          ]),
          environment: {
            HOME: root,
            PATH: process.env.PATH ?? "",
            LOHRA_DOCTRINE: "loud",
          },
          home: join(root, ".lohra"),
          codexHome: join(root, ".codex"),
          cwd: root,
        }),
      ).rejects.toThrow(/LOHRA_DOCTRINE/);
    } finally {
      await closeServer(server);
    }
  });
});
