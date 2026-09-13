// Issue #580 (épico #575, P4), AC 3: "dashboard monta o prompt com os
// mesmos inputs de chat" — antes desta issue, `dashboard.ts` só passava
// `doctrine`/`contextFiles`/`environmentHints` a `buildSystemPrompt`
// (nunca identidade, memória, perfil ou índice de skills). Molda-se em
// `tests/workflow-durable-dashboard.test.ts` (boot real via `runDashboard`,
// WS real, SSE real — `runDashboard` sempre cria transports com
// `streaming: true`, ver a nota daquele arquivo) para capturar o prompt de
// verdade que o gateway manda ao provedor, não uma reconstrução em teste.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { runDashboard, type DashboardCommandOptions } from "../../src/commands/dashboard.js";
import { registerProvider } from "../../src/providers/registry.js";

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

// `runDashboard` always builds ChatCompletionsModel with `streaming: true`
// (dashboard.ts, unlike chat.ts's `--json` turn) — same SSE wire format as
// `tests/workflow-durable-dashboard.test.ts`'s `sseTextTurn`.
function sseTextTurn(text: string): string {
  const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }], usage: null })}\n\n`;
  const stop = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null })}\n\n`;
  return `${delta}${stop}data: [DONE]\n\n`;
}

interface CapturedRequest {
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

function startCapturingServer(captured: CapturedRequest[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      captured.push(body);
      const text = sseTextTurn("ok");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

const messageQueues = new WeakMap<
  WebSocket,
  { readonly queue: string[]; readonly waiters: ((value: string) => void)[] }
>();

function queueFor(ws: WebSocket): {
  readonly queue: string[];
  readonly waiters: ((value: string) => void)[];
} {
  let state = messageQueues.get(ws);
  if (state === undefined) {
    state = { queue: [], waiters: [] };
    messageQueues.set(ws, state);
    ws.on("message", (data) => {
      const text = Buffer.from(data as Buffer).toString("utf8");
      const waiter = state?.waiters.shift();
      if (waiter !== undefined) waiter(text);
      else state?.queue.push(text);
    });
  }
  return state;
}

function nextMessage(ws: WebSocket): Promise<string> {
  const state = queueFor(ws);
  const queued = state.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolvePromise) => state.waiters.push(resolvePromise));
}

describe("dashboard.ts's real prompt (issue #580 AC 3): same inputs as chat's snapshot()", () => {
  it("a real WS turn's system message carries identity, memory, user profile, and the skills index — none of which dashboard sent before this issue", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t580-dashboard-prompt-"));
    roots.push(root);
    const home = join(root, ".lohra");
    // MemoryStore reads <home>/memories/{MEMORY,USER}.md verbatim (src/memory/store.ts).
    mkdirSync(join(home, "memories"), { recursive: true });
    writeFileSync(join(home, "memories", "MEMORY.md"), "T580-MEMORY-MARKER");
    writeFileSync(join(home, "memories", "USER.md"), "T580-USER-PROFILE-MARKER");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t580-dashboard-prompt-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T580 dashboard prompt probe",
        description: "Local in-memory composition-root probe (issue #580).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t580-dashboard-prompt-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const stderrLines: string[] = [];
      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        flags: new Map([
          ["--provider", provider],
          ["--model", "t580-dashboard-prompt-model"],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home,
        codexHome: join(root, ".codex"),
        cwd: root,
        stderr: (text) => stderrLines.push(text),
        port: 0,
        registerShutdownTrigger: (handler) => {
          shutdown = handler;
        },
      };
      const donePromise = runDashboard(options);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      const boundLine = stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
      const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
      const wsLine = stderrLines.find((line) => line.startsWith("WebSocket:"));
      const token = wsLine?.match(/token=([^\n]+)\n$/)?.[1];
      expect(token).toBeDefined();

      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${String(token)}`);
      await nextMessage(ws); // gateway.ready
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: "create", method: "session.create", params: {} }),
      );
      const createResult = JSON.parse(await nextMessage(ws)) as {
        result: { session_id: string };
      };
      await nextMessage(ws); // session.info
      const sessionId = createResult.result.session_id;

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "prompt.submit",
          params: { session_id: sessionId, text: "hi" },
        }),
      );
      await nextMessage(ws); // rpc-ok
      let complete = false;
      while (!complete) {
        const frame = JSON.parse(await nextMessage(ws)) as { params: { type: string } };
        if (frame.params.type === "message.complete") complete = true;
      }
      ws.close();
      shutdown?.();
      await donePromise;

      expect(captured.length).toBeGreaterThan(0);
      const system = captured[0]?.messages.find((message) => message.role === "system");
      const content = typeof system?.content === "string" ? system.content : "";
      expect(content).toContain("<memory>\nT580-MEMORY-MARKER\n</memory>");
      expect(content).toContain("<user-profile>\nT580-USER-PROFILE-MARKER\n</user-profile>");
      expect(content).toContain("workflow-authoring");
      expect(content).toContain("Harness:");
      expect(content).toContain("Report what you actually did");
    } finally {
      await closeServer(server);
    }
  });
});
