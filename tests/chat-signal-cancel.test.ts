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

function fixture(holdFirst: boolean) {
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
) {
  return {
    input: "trabalho interrompível",
    flags: new Map<string, string | true>([
      ["--provider", provider],
      ["--model", "signal-model"],
      ["--json", true],
      ["--no-input", true],
      ["--no-tools", true],
      ...(sessionId === undefined ? [] : [["--session", sessionId] as const]),
    ]),
    environment: { HOME: root, LOHRA_HOME: join(root, ".lohra"), PATH: process.env.PATH ?? "" },
    home: join(root, ".lohra"),
    codexHome: join(root, ".codex"),
    cwd: root,
    registerShutdownTrigger: register,
  };
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

  it("cancels an in-flight call, reports its session, and overlays the notice on resume", async () => {
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
      expect(requests[1]).toContain("OPERATOR NOTICES");
      expect(requests[1]).toContain("cancelled");

      const afterAck = await runChat(
        options(root, provider, signalRegistration().register, envelope.session_id),
      );
      expect(afterAck.code).toBe(0);
      expect(requests[2]).not.toContain("OPERATOR NOTICES");
    } finally {
      await close(server);
    }
  });
});
