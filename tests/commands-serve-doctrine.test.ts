// Issue #648 (grupo A, item 7a de #637): `serve.ts:123-125` resolves the
// doctrine tier once at process boot, but no test ever read the REAL
// upstream request `serve` sends -- `tests/commands-serve.test.ts:45-91`
// only boots `runServe` and probes the port/banner (`server-service.test.ts`
// tests `CompletionService` in isolation, with an injected `systemPrompt: ()
// => "system"`, never the real string). This is the new harness the issue
// asks for: `runServe` boots for real, a real HTTP POST hits its
// OpenAI-compatible `/v1/chat/completions`, and the request `serve` forwards
// upstream (to a local stub, via `LOHRA_PROVIDER_BASE_URL`... except
// `serve.ts` never reads that var -- the provider's own registered
// `baseUrl` is what routes upstream here) is captured and inspected.
import { createServer, type Server } from "node:http";
import net from "node:net";

import { describe, expect, it } from "vitest";

import { runServe, type ServeCommandOptions } from "../src/commands/serve.js";
import { registerProvider } from "../src/providers/registry.js";

function collector(): { readonly text: () => string; readonly write: (value: string) => void } {
  let buffer = "";
  return {
    text: () => buffer,
    write: (value) => {
      buffer += value;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface CapturedRequest {
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

function startUpstreamServer(captured: CapturedRequest[]): {
  readonly server: Server;
  readonly listen: () => Promise<number>;
} {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      captured.push(body);
      const payload = {
        id: "chatcmpl-t648-serve-doctrine",
        object: "chat.completion",
        created: 0,
        model: "t648-serve-doctrine-model",
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
  return {
    server,
    listen: () =>
      new Promise<number>((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolvePromise(typeof address === "object" && address !== null ? address.port : 0);
        });
      }),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

function systemContentOf(captured: CapturedRequest): string {
  const system = captured.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

describe("serve.ts wires the resolved doctrine tier into the real upstream request (issue #648, #637 item 7a)", () => {
  it("a non-ollama provider defaults to extended: DOCTRINE_EXTENDED's own marker reaches the upstream system message", async () => {
    const captured: CapturedRequest[] = [];
    const { server: upstream, listen } = startUpstreamServer(captured);
    const upstreamPort = await listen();
    try {
      const providerName = `t648-serve-doctrine-probe-${String(Math.random()).slice(2)}`;
      registerProvider({
        name: providerName,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 serve doctrine probe",
        description: "Local upstream stub for issue #648.",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-serve-doctrine-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const port = await freePort();
      const stderr = collector();
      const options: ServeCommandOptions = {
        configuration: { host: "127.0.0.1", port, insecure: true, tools: "" },
        environment: { PATH: process.env.PATH ?? "", LOHRA_PROVIDER: providerName },
        stdout: () => undefined,
        stderr: stderr.write,
      };
      const runPromise = runServe(options);
      await waitFor(() => stderr.text().includes("Lohra OpenAI server:"));

      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "t648-serve-doctrine-model",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      expect(response.status).toBe(200);
      await response.json();

      expect(captured).toHaveLength(1);
      expect(systemContentOf(captured[0] as CapturedRequest)).toContain("One idea per sentence");

      process.emit("SIGINT", "SIGINT");
      expect(await runPromise).toBe(0);
    } finally {
      await closeServer(upstream);
    }
  });

  it("LOHRA_DOCTRINE=core overrides the extended default: the marker is absent from the upstream request", async () => {
    const captured: CapturedRequest[] = [];
    const { server: upstream, listen } = startUpstreamServer(captured);
    const upstreamPort = await listen();
    try {
      const providerName = `t648-serve-doctrine-core-probe-${String(Math.random()).slice(2)}`;
      registerProvider({
        name: providerName,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 serve doctrine core probe",
        description: "Local upstream stub for issue #648.",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-serve-doctrine-core-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const port = await freePort();
      const stderr = collector();
      const options: ServeCommandOptions = {
        configuration: { host: "127.0.0.1", port, insecure: true, tools: "" },
        environment: {
          PATH: process.env.PATH ?? "",
          LOHRA_PROVIDER: providerName,
          LOHRA_DOCTRINE: "core",
        },
        stdout: () => undefined,
        stderr: stderr.write,
      };
      const runPromise = runServe(options);
      await waitFor(() => stderr.text().includes("Lohra OpenAI server:"));

      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "t648-serve-doctrine-core-model",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      expect(response.status).toBe(200);
      await response.json();

      expect(captured).toHaveLength(1);
      expect(systemContentOf(captured[0] as CapturedRequest)).not.toContain(
        "One idea per sentence",
      );

      process.emit("SIGINT", "SIGINT");
      expect(await runPromise).toBe(0);
    } finally {
      await closeServer(upstream);
    }
  });

  it("an invalid LOHRA_DOCTRINE fails closed with a named error instead of silently falling back", async () => {
    const providerName = `t648-serve-doctrine-bad-probe-${String(Math.random()).slice(2)}`;
    registerProvider({
      name: providerName,
      apiMode: "chat_completions",
      aliases: [],
      displayName: "T648 serve doctrine bad-value probe",
      description: "Local upstream stub for issue #648 (never reached).",
      signupUrl: "",
      envVars: [],
      baseUrl: "http://127.0.0.1:1/v1",
      modelsUrl: "",
      requiresApiKey: false,
      supportsVision: false,
      fallbackModels: ["t648-serve-doctrine-bad-model"],
      defaultMaxTokens: 256,
      defaultAuxModel: "",
    });

    const port = await freePort();
    const options: ServeCommandOptions = {
      configuration: { host: "127.0.0.1", port, insecure: true, tools: "" },
      environment: {
        PATH: process.env.PATH ?? "",
        LOHRA_PROVIDER: providerName,
        LOHRA_DOCTRINE: "loud",
      },
      stdout: () => undefined,
      stderr: () => undefined,
    };
    await expect(runServe(options)).rejects.toThrow(/LOHRA_DOCTRINE/);
  });
});
