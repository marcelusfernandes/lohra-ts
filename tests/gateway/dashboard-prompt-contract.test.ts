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

// Issue #641 (épico #637, grupo F, item 21): o `setTimeout(50)` fixo abaixo
// era uma suposição de tempo, não um sinal de prontidão — troca por espera
// ativa pela linha `Lohra dashboard:` que `runDashboard` escreve no stderr
// assim que o listener está de pé (veredito PR #611, non_blocking 7).
async function waitForStderrLine(lines: readonly string[], prefix: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = lines.find((line) => line.startsWith(prefix));
    if (found !== undefined) return found;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`timed out waiting for a stderr line starting with "${prefix}"`);
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
    // Issue #641 (épico #637, grupo F, item 21): loadSoul(<home>/SOUL.md)
    // (src/memory/soul.ts:6) fica inexercitado sem isto — sem SOUL.md o
    // prompt cai em DEFAULT_IDENTITY e dashboard.ts:296,318 nunca é provado
    // (veredito PR #611, non_blocking 7-8).
    writeFileSync(join(home, "SOUL.md"), "T580-SOUL-MARKER");

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
      const boundLine = await waitForStderrLine(stderrLines, "Lohra dashboard:");
      const port = Number(boundLine.match(/:(\d+)\n$/)?.[1]);
      const wsLine = await waitForStderrLine(stderrLines, "WebSocket:");
      const token = wsLine.match(/token=([^\n]+)\n$/)?.[1];
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
      expect(content).toContain("T580-SOUL-MARKER");
      expect(content).toContain("workflow-authoring");
      expect(content).toContain("Harness:");
      expect(content).toContain("Report what you actually did");
    } finally {
      await closeServer(server);
    }
  });

  // Issue #648 (grupo A, item 7a de #637): same gap as chat/serve --
  // `dashboard.ts:289-291` resolves `resolveDoctrineTier` once at boot, but
  // no test ever checked that the resolved tier actually reaches the real
  // WS turn's system message. This file already boots `runDashboard` for
  // real and captures the upstream request (see the note at the top of this
  // file), so the doctrine pin belongs here rather than in a new file
  // (issue #648's own sequencing note: only a NEW file if #641 had not yet
  // merged -- it has, PR #644).
  it("a non-ollama provider defaults to extended: DOCTRINE_EXTENDED's own marker reaches the real WS turn's system message", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t648-dashboard-doctrine-"));
    roots.push(root);
    const home = join(root, ".lohra");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t648-dashboard-doctrine-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 dashboard doctrine probe",
        description: "Local in-memory composition-root probe (issue #648).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-dashboard-doctrine-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const stderrLines: string[] = [];
      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        flags: new Map([
          ["--provider", provider],
          ["--model", "t648-dashboard-doctrine-model"],
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
      const boundLine = await waitForStderrLine(stderrLines, "Lohra dashboard:");
      const port = Number(boundLine.match(/:(\d+)\n$/)?.[1]);
      const wsLine = await waitForStderrLine(stderrLines, "WebSocket:");
      const token = wsLine.match(/token=([^\n]+)\n$/)?.[1];
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
      expect(content).toContain("One idea per sentence");
    } finally {
      await closeServer(server);
    }
  });
});
