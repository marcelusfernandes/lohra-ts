// Issue #651 (sub-issue C1 de #637): dois mecanismos que já existiam, sem
// caller de produção na gateway WS. `tests/gateway/ws-connection-notices.
// test.ts` (issue #608 AC4) prova o MECANISMO com um port fake injetado
// direto em `createGatewayUpgradeHandler`; nenhum teste antes desta issue
// passava por `runDashboard` de verdade. `tests/gateway/dashboard-prompt-
// contract.test.ts` (issue #580) é o molde: boot real, WS real, stub HTTP
// captura o request que o gateway manda ao provedor.
//
// 1. `GatewayWsDeps.notices` (issue #608 AC4): antes desta issue,
//    `dashboard.ts` (o único construtor de `GatewayWsDeps`) não populava o
//    campo — um aviso pendente em `operator_notices` nunca chegava a um
//    turno da UI web. Prova aqui: um aviso `global` semeado antes do boot
//    chega ao request upstream do turno na MENSAGEM DO USUÁRIO (nunca no
//    `system`, invariante 1 — mesmo pino de #608 AC3, provado à unidade em
//    `tests/conversation-runtime-notices.test.ts`) e fica `acked` depois.
// 2. `GatewayWsDeps.summarize` (issue #587 AC1): `dashboard.ts` já
//    construía um `AuxClient` para o job runner do cron; o caminho
//    interativo da gateway WS ficava fora (gap documentado em
//    `docs/context-compaction.md`). Prova aqui: com `defaultAuxModel` e uma
//    janela de contexto pequena o bastante para forçar compactação, o
//    request de resumo sai com `model === defaultAuxModel`; sem
//    `defaultAuxModel`, a compactação ainda acontece (fallback ao
//    transporte do próprio turno, comportamento pré-#587/#651), só que
//    nenhum request carrega o modelo auxiliar.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { runDashboard, type DashboardCommandOptions } from "../../src/commands/dashboard.js";
import { registerProvider } from "../../src/providers/registry.js";
import { openStateDatabase, NoticesRepository, SessionRepository } from "../../src/state/index.js";

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
// for the turn's own transport (`dashboard-prompt-contract.test.ts`'s own
// note) — that transport is ALSO what the runtime's default (fallback)
// summarizer reuses when no `summarize` option is wired. `AuxClient.create`
// (`src/agent/aux.ts`), the real aux-model call, never sets `stream` at all
// (`ChatCompletionsClient.create`, unlike `.stream`). The two shapes never
// collide on this one stub server: `body.stream` alone tells them apart.
function sseTextTurn(text: string): string {
  const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }], usage: null })}\n\n`;
  const stop = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null })}\n\n`;
  return `${delta}${stop}data: [DONE]\n\n`;
}

function jsonCompletionTurn(text: string): string {
  return JSON.stringify({
    id: "chatcmpl-t651",
    object: "chat.completion",
    created: 0,
    model: "t651-reply-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

interface CapturedRequest {
  readonly model: string;
  readonly stream?: boolean;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
}

function startCapturingServer(captured: CapturedRequest[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      captured.push(body);
      if (body.stream) {
        const text = sseTextTurn("ok");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
        return;
      }
      const text = jsonCompletionTurn("a summary");
      response.writeHead(200, {
        "content-type": "application/json",
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

async function waitForStderrLine(lines: readonly string[], prefix: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = lines.find((line) => line.startsWith(prefix));
    if (found !== undefined) return found;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`timed out waiting for a stderr line starting with "${prefix}"`);
}

interface BootedDashboard {
  readonly wsUrl: string;
  readonly donePromise: Promise<number>;
  readonly shutdown: () => void;
}

async function bootDashboard(
  root: string,
  home: string,
  provider: string,
  model: string,
): Promise<BootedDashboard> {
  const stderrLines: string[] = [];
  let shutdown: (() => void) | undefined;
  const options: DashboardCommandOptions = {
    flags: new Map([
      ["--provider", provider],
      ["--model", model],
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
  if (token === undefined) throw new Error("no token in the WebSocket: stderr line");
  return {
    wsUrl: `ws://127.0.0.1:${String(port)}/api/ws?token=${token}`,
    donePromise,
    shutdown: () => shutdown?.(),
  };
}

async function createSession(ws: WebSocket, sessionId?: string): Promise<string> {
  await nextMessage(ws); // gateway.ready
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "create",
      method: "session.create",
      params: sessionId === undefined ? {} : { session_id: sessionId },
    }),
  );
  const createResult = JSON.parse(await nextMessage(ws)) as { result: { session_id: string } };
  await nextMessage(ws); // session.info
  return createResult.result.session_id;
}

async function submitAndAwaitCompletion(
  ws: WebSocket,
  sessionId: string,
  text: string,
): Promise<Readonly<Record<string, unknown>>> {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "prompt.submit",
      params: { session_id: sessionId, text },
    }),
  );
  await nextMessage(ws); // rpc-ok
  let complete = false;
  let lastFrame: Readonly<Record<string, unknown>> = {};
  while (!complete) {
    const frame = JSON.parse(await nextMessage(ws)) as {
      params: { type: string; payload?: Readonly<Record<string, unknown>> };
    };
    if (frame.params.type === "message.complete") {
      complete = true;
      lastFrame = frame.params.payload ?? frame;
    }
  }
  return lastFrame;
}

// 800 filler chars -> ~276 estimated text tokens per message
// (src/context/token-estimate.ts's TEXT_CHARS_PER_TOKEN, same constant
// tests/chat-compaction-events.test.ts's seedLongHistory relies on); 20
// turns (40 messages) sits well over the small provider-floor window the
// summarize tests below register, while the turn-aligned kept tail stays
// comfortably under it.
function seedLongHistory(home: string, sessionId: string, model: string): void {
  const connection = openStateDatabase(join(home, "state.db"));
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  sessions.createSession({ id: sessionId, model, systemPrompt: "seed", cwd: "/tmp" });
  const filler = "x".repeat(800);
  for (let turn = 0; turn < 20; turn += 1) {
    sessions.recordTurn(sessionId, {
      user: { role: "user", content: `q${String(turn)} ${filler}` },
      assistant: { role: "assistant", content: `a${String(turn)} ${filler}`, finishReason: "stop" },
    });
  }
  connection.close();
}

describe("dashboard.ts wires GatewayWsDeps.notices onto real WS turns (issue #608 AC4, closed for this surface by #651)", () => {
  it("a pending global notice reaches a real WS turn's user message (never the system) and is acked after", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t651-overlay-notices-"));
    roots.push(root);
    const home = join(root, ".lohra");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t651-dashboard-notices-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T651 dashboard notices probe",
        description: "Local in-memory composition-root probe (issue #651).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t651-notices-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      // Seeded BEFORE the boot, on the exact same state.db `runDashboard`
      // opens (`{HOME: root}` with no `LOHRA_HOME` override resolves to
      // `join(root, ".lohra")`, #653's rule). Closed before boot: no
      // concurrent writer contends with `runDashboard`'s own connection.
      const seedConnection = openStateDatabase(join(home, "state.db"));
      const seededNotice = new NoticesRepository(seedConnection.database).append("global", {
        kind: "unknown",
        message: "T651 seeded operator notice",
      });
      seedConnection.close();
      if (seededNotice === null) throw new Error("seed: notices.append('global', ...) refused");

      const dashboard = await bootDashboard(root, home, provider, "t651-notices-model");
      const ws = new WebSocket(dashboard.wsUrl);
      const sessionId = await createSession(ws);
      await submitAndAwaitCompletion(ws, sessionId, "hi");
      ws.close();
      dashboard.shutdown();
      await dashboard.donePromise;

      expect(captured.length).toBeGreaterThan(0);
      const turnRequest = captured[0];
      if (turnRequest === undefined) throw new Error("no request captured");
      const system = turnRequest.messages.find((message) => message.role === "system");
      const systemContent = typeof system?.content === "string" ? system.content : "";
      expect(systemContent).not.toContain("OPERATOR NOTICES");
      const user = turnRequest.messages.find((message) => message.role === "user");
      const userContent = typeof user?.content === "string" ? user.content : "";
      expect(userContent).toContain("OPERATOR NOTICES (not the user speaking):");
      expect(userContent).toContain("T651 seeded operator notice");
      expect(userContent).toContain("hi");

      const afterConnection = openStateDatabase(join(home, "state.db"));
      const afterNotices = new NoticesRepository(afterConnection.database);
      const page = afterNotices.list({ scope: "global", includeAcked: true });
      afterConnection.close();
      const ackedRow = page.notices.find((row) => row.id === seededNotice.id);
      expect(ackedRow?.acked_at).not.toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});

describe("dashboard.ts wires GatewayWsDeps.summarize onto real WS turns (issue #587 AC1, closed for this surface by #651)", () => {
  it("with defaultAuxModel configured, a real WS turn's compaction request carries model === defaultAuxModel", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t651-overlay-aux-"));
    roots.push(root);
    const home = join(root, ".lohra");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t651-dashboard-aux-probe";
      const model = "t651-aux-main-model";
      const auxModel = "t651-aux-summary-model";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T651 dashboard aux probe",
        description: "Local in-memory composition-root probe (issue #651).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: [model],
        defaultMaxTokens: 256,
        defaultAuxModel: auxModel,
        // Provider-floor precedence level (src/providers/context-window.ts)
        // -- no LOHRA_CONTEXT_WINDOW override needed (the WS path's
        // ConversationRuntime doesn't forward `environment` to
        // `preflightCompact`, so an env override wouldn't reach it here).
        // 22000 straddles the real threshold for THIS turn's own request
        // shape with margin on both sides: the seeded 40-message filler
        // history alone exceeds it (forcing compaction), but the full
        // session tool registry `dashboard.ts` always wires in
        // (`toolDefinitions`, counted in every estimate, compaction never
        // shrinks it -- ~9000 tokens measured against this fixture) plus
        // the compacted 8-message tail still fit comfortably under it
        // afterwards. A window in the low thousands never lets compaction
        // "succeed" here (the tool registry alone already exceeds it); this
        // margin (~4000 tokens either side of threshold, measured against
        // the fixture as of this issue) tolerates the tool registry growing
        // over time without flipping this test red on an unrelated PR.
        defaultContextWindow: 22000,
      });

      const sessionId = "t651-aux-seeded-session";
      seedLongHistory(home, sessionId, model);

      const dashboard = await bootDashboard(root, home, provider, model);
      const ws = new WebSocket(dashboard.wsUrl);
      await createSession(ws, sessionId);
      const outcome = await submitAndAwaitCompletion(ws, sessionId, "continue");
      ws.close();
      dashboard.shutdown();
      await dashboard.donePromise;

      expect(outcome.status).toBe("complete");
      const auxRequests = captured.filter((request) => request.model === auxModel);
      expect(auxRequests.length).toBeGreaterThan(0);
      const auxRequest = auxRequests[0];
      if (auxRequest === undefined) throw new Error("no aux request captured");
      expect(auxRequest.stream).not.toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("without defaultAuxModel, compaction still happens but no request ever names an aux model (byte-identical to before #651)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t651-overlay-noaux-"));
    roots.push(root);
    const home = join(root, ".lohra");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t651-dashboard-noaux-probe";
      const model = "t651-noaux-main-model";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T651 dashboard no-aux probe",
        description: "Local in-memory composition-root probe (issue #651).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: [model],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
        // Same window as the sibling "with defaultAuxModel" test above --
        // see its comment for the margin rationale.
        defaultContextWindow: 22000,
      });

      const sessionId = "t651-noaux-seeded-session";
      seedLongHistory(home, sessionId, model);

      const dashboard = await bootDashboard(root, home, provider, model);
      const ws = new WebSocket(dashboard.wsUrl);
      await createSession(ws, sessionId);
      const outcome = await submitAndAwaitCompletion(ws, sessionId, "continue");
      ws.close();
      dashboard.shutdown();
      await dashboard.donePromise;

      // Still compacts (the seeded history is well over the resolved
      // window) via the turn's OWN transport -- the default fallback
      // summarizer (runtime.ts's `defaultSummarize`), same as every
      // gateway WS turn before this issue: at least the compaction's own
      // request plus the turn's own, all naming the turn's own model,
      // never an aux one (there is no `defaultAuxModel` here to name).
      expect(outcome.status).toBe("complete");
      expect(captured.length).toBeGreaterThan(1);
      for (const request of captured) expect(request.model).toBe(model);
    } finally {
      await closeServer(server);
    }
  });
});
