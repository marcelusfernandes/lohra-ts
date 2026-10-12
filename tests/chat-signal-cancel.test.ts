import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function fixture(holdFirst: boolean, failureStatus?: number, toolCommand?: string) {
  const root = mkdtempSync(join(tmpdir(), "lohra-chat-signal-"));
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
      requests.push(Buffer.concat(chunks).toString("utf8"));
      receivedFirst();
      if (holdFirst && requests.length === 1) return;
      if (failureStatus !== undefined) {
        response.writeHead(failureStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "real upstream fault" } }));
        return;
      }
      if (toolCommand !== undefined && requests.length === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-signal-tool",
            object: "chat.completion",
            created: 0,
            model: "signal-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "terminal-1",
                      type: "function",
                      function: {
                        name: "terminal",
                        arguments: JSON.stringify({ command: toolCommand, timeout: 30 }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-signal",
          object: "chat.completion",
          created: 0,
          model: "signal-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
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
  const provider = `signal-probe-${String(address.port)}`;
  registerProvider({
    name: provider,
    apiMode: "chat_completions",
    aliases: [],
    displayName: "Signal probe",
    description: "Local chat cancellation fixture",
    signupUrl: "",
    envVars: [],
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    modelsUrl: "",
    requiresApiKey: false,
    supportsVision: false,
    fallbackModels: ["signal-model"],
    defaultMaxTokens: 256,
    defaultAuxModel: "",
  });
  return provider;
}

function signalRegistration() {
  let handler: (() => void) | null = null;
  let removals = 0;
  return {
    register: (callback: () => void): (() => void) => {
      handler = callback;
      return () => {
        handler = null;
        removals += 1;
      };
    },
    fire: (): void => {
      if (handler === null) throw new Error("signal handler not registered");
      handler();
    },
    removals: () => removals,
    armed: () => handler !== null,
  };
}

function options(
  root: string,
  provider: string,
  register: (handler: () => void) => () => void,
  sessionId?: string,
  withTools = false,
) {
  return {
    input: "trabalho interrompível",
    flags: new Map<string, string | true>([
      ["--provider", provider],
      ["--model", "signal-model"],
      ["--json", true],
      ["--no-input", true],
      ...(withTools ? [["--yolo", true] as const] : [["--no-tools", true] as const]),
      ...(sessionId === undefined ? [] : [["--session", sessionId] as const]),
    ]),
    environment: { HOME: root, LOHRA_HOME: join(root, ".lohra"), PATH: process.env.PATH ?? "" },
    home: join(root, ".lohra"),
    codexHome: join(root, ".codex"),
    cwd: root,
    registerShutdownTrigger: register,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("terminal tool did not start");
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

describe("chat signal cancellation (#920)", () => {
  it("completes normally and removes its signal handler", async () => {
    const { root, server } = fixture(false);
    const provider = await start(server);
    const signal = signalRegistration();
    try {
      const result = await runChat(options(root, provider, signal.register));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ completed: true, error: null });
      expect(signal.armed()).toBe(false);
      expect(signal.removals()).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("keeps a real provider failure causal when no signal fired", async () => {
    const { root, server } = fixture(false, 503);
    const provider = await start(server);
    const signal = signalRegistration();
    try {
      const result = await runChat(options(root, provider, signal.register));
      const envelope = JSON.parse(result.stdout) as { error: string; completed: boolean };
      expect(result.code).toBe(1);
      expect(envelope.completed).toBe(false);
      expect(envelope.error).toContain("503");
      expect(envelope.error).not.toMatch(/cancel/i);
      expect(signal.removals()).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("cancels an in-flight call, reports its session, and presents the notice on resume", async () => {
    const { root, server, requests, firstRequest } = fixture(true);
    const provider = await start(server);
    const signal = signalRegistration();
    try {
      const turn = runChat(options(root, provider, signal.register));
      await firstRequest;
      signal.fire();
      const cancelled = await turn;
      const envelope = JSON.parse(cancelled.stdout) as {
        session_id: string;
        completed: boolean;
        error: string;
      };
      expect(cancelled.code).not.toBe(0);
      expect(envelope.completed).toBe(false);
      expect(envelope.session_id).not.toBe("");
      expect(envelope.error).toMatch(/cancel/i);
      expect(cancelled.stderr).toContain(`session: ${envelope.session_id}`);
      expect(requests).toHaveLength(1);
      expect(signal.armed()).toBe(false);
      expect(signal.removals()).toBe(1);

      const resumed = await runChat(
        options(root, provider, signalRegistration().register, envelope.session_id),
      );
      expect(resumed.code).toBe(0);
      expect(requests).toHaveLength(2);
      const resumedEnvelope = JSON.parse(resumed.stdout) as {
        session_notices?: readonly { readonly kind: string; readonly message: string }[];
      };
      expect(resumedEnvelope.session_notices?.[0]?.kind).toBe("cancelled");
      expect(resumedEnvelope.session_notices?.[0]?.message).toContain("trabalho interrompível");
      expect(requests[1]).not.toContain("CONVERSATION_CANCELLED");

      const afterAck = await runChat(
        options(root, provider, signalRegistration().register, envelope.session_id),
      );
      expect(afterAck.code).toBe(0);
      expect(JSON.parse(afterAck.stdout) as Record<string, unknown>).not.toHaveProperty(
        "session_notices",
      );
      expect(requests[2]).not.toContain("OPERATOR NOTICES");
    } finally {
      await close(server);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "cancels a running terminal tool before another model call",
    async () => {
      const markerRoot = mkdtempSync(join(tmpdir(), "lohra-chat-terminal-signal-"));
      roots.push(markerRoot);
      const scriptPath = join(markerRoot, "held.cjs");
      const marker = join(markerRoot, "started");
      writeFileSync(
        scriptPath,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => {}, 30000);`,
      );
      const command = `node "${scriptPath.replaceAll("\\", "/")}"`;
      const { root, server, requests } = fixture(false, undefined, command);
      const provider = await start(server);
      const signal = signalRegistration();
      try {
        const turn = runChat(options(root, provider, signal.register, undefined, true));
        await waitForFile(marker);
        const started = performance.now();
        signal.fire();
        const result = await turn;
        const envelope = JSON.parse(result.stdout) as {
          session_id: string;
          completed: boolean;
          error: string;
        };
        expect(performance.now() - started).toBeLessThan(10_000);
        expect(result.code).toBe(1);
        expect(envelope).toMatchObject({ completed: false, error: "conversation cancelled" });
        expect(envelope.session_id).not.toBe("");
        expect(requests).toHaveLength(1);
      } finally {
        await close(server);
      }
    },
    15_000,
  );
});
