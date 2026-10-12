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

function fixture(failFirstResume = false) {
  const root = mkdtempSync(join(tmpdir(), "lohra-cancel-notice-"));
  roots.push(root);
  const requests: string[] = [];
  let receivedFirst = (): void => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    receivedFirst = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push(raw);
      receivedFirst();
      if (requests.length === 1) return;
      if (failFirstResume && raw.includes("Resume?")) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "old provider fault" } }));
        return;
      }
      if ((JSON.parse(raw) as { stream?: boolean }).stream === true) {
        const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: "model answer" }, finish_reason: null }], usage: null })}\n\n`;
        const stop = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`${delta}${stop}data: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-notice",
          object: "chat.completion",
          created: 0,
          model: "notice-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "model answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  return { root, server, requests, firstRequest };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  const provider = `notice-probe-${String(address.port)}`;
  registerProvider({
    name: provider,
    apiMode: "chat_completions",
    aliases: [],
    displayName: "Notice probe",
    description: "Local cancellation notice fixture",
    signupUrl: "",
    envVars: [],
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    modelsUrl: "",
    requiresApiKey: false,
    supportsVision: false,
    fallbackModels: ["notice-model"],
    defaultMaxTokens: 256,
    defaultAuxModel: "",
  });
  return provider;
}

function options(root: string, provider: string, input: string, sessionId?: string, json = true) {
  return {
    input,
    flags: new Map<string, string | true>([
      ["--provider", provider],
      ["--model", "notice-model"],
      ["--no-input", true],
      ["--no-tools", true],
      ...(json ? [["--json", true] as const] : []),
      ...(sessionId === undefined ? [] : [["--session", sessionId] as const]),
    ]),
    environment: { HOME: root, LOHRA_HOME: join(root, ".lohra"), PATH: process.env.PATH ?? "" },
    home: join(root, ".lohra"),
    codexHome: join(root, ".codex"),
    cwd: root,
  };
}

async function cancelled(
  root: string,
  provider: string,
  firstRequest: Promise<void>,
  input: string,
): Promise<string> {
  let stop = (): void => undefined;
  const initial = runChat({
    ...options(root, provider, input),
    registerShutdownTrigger: (handler) => {
      stop = handler;
      return () => undefined;
    },
  });
  await firstRequest;
  stop();
  const result = await initial;
  expect(result.code).toBe(1);
  const envelope = JSON.parse(result.stdout) as { completed: boolean; session_id: string };
  expect(envelope.completed).toBe(false);
  return envelope.session_id;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}

describe("CLI cancelled task notice (#923)", () => {
  it("shows a Lohra status before model text, without leaking control lines or feeding it to the model", async () => {
    const { root, server, requests, firstRequest } = fixture();
    const provider = await start(server);
    try {
      const sessionId = await cancelled(
        root,
        provider,
        firstRequest,
        "Write the report\n\u001b[31mFAKE_STATUS",
      );
      const resumed = await runChat(options(root, provider, "What happened?", sessionId, false));
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toMatch(/^Lohra session notice:/);
      expect(resumed.stdout.indexOf("Write the report")).toBeLessThan(
        resumed.stdout.indexOf("model answer"),
      );
      expect(resumed.stdout).not.toContain("\u001b");
      expect(resumed.stdout).not.toMatch(/\nFAKE_STATUS/);
      expect(requests[1]).not.toContain("CONVERSATION_CANCELLED");
      expect(requests[1]).not.toContain("Write the report");

      const afterAck = await runChat(options(root, provider, "And now?", sessionId, false));
      expect(afterAck.stdout).toBe("model answer\n");
    } finally {
      await close(server);
    }
  });

  it("keeps one JSON envelope with the notice on failed resume and re-delivers until success", async () => {
    const { root, server, firstRequest } = fixture(true);
    const provider = await start(server);
    try {
      const sessionId = await cancelled(root, provider, firstRequest, "Write the newer report");
      const failed = await runChat(options(root, provider, "Resume?", sessionId));
      const failure = JSON.parse(failed.stdout) as Record<string, unknown>;
      expect(failed.code).toBe(1);
      expect(failure.completed).toBe(false);
      const failedNotices = failure.session_notices as
        | readonly { readonly id: number; readonly kind: string; readonly message: string }[]
        | undefined;
      expect(failedNotices).toHaveLength(1);
      expect(failedNotices?.[0]?.id).toBeGreaterThan(0);
      expect(failedNotices?.[0]?.kind).toBe("cancelled");
      expect(failedNotices?.[0]?.message).toContain("Write the newer report");
      expect(failed.stdout.trimEnd().endsWith("}")).toBe(true);

      const resumed = await runChat(options(root, provider, "Resume again?", sessionId));
      const success = JSON.parse(resumed.stdout) as Record<string, unknown>;
      expect(resumed.code).toBe(0);
      expect(success.output).toBe("model answer");
      expect(success.session_notices).toEqual(failedNotices);

      const afterAck = await runChat(options(root, provider, "After ack?", sessionId));
      expect(JSON.parse(afterAck.stdout) as Record<string, unknown>).not.toHaveProperty(
        "session_notices",
      );
    } finally {
      await close(server);
    }
  });
});
