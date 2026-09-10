// Issue #287 (revisor round 2 of PR #284, items 4 and 5): nothing that
// constructs a ConversationRuntime in production wires `eventSink` --
// "session.compacted"/"compaction.unsupported" only ever reached a test's
// own fake sink (tests/conversation-runtime.test.ts). This file pins the
// gateway ws side of the fix: the two compaction events reach the socket as
// `event` frames, and the Codex subscription route's maxTokens resolves to
// its real profile instead of silently falling back to null through a
// provider name nothing registers ("codex" -- see resolveGatewayMaxTokens's
// own doc comment, src/gateway/ws/connection.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { SqliteConversationRepository } from "../src/conversation/index.js";
import type {
  ConversationRepository,
  ModelRequest,
  ModelTransport,
} from "../src/conversation/types.js";
import { jsonResponse } from "../src/gateway/http/response.js";
import { startGatewayHttpServer, type GatewayHttpServer } from "../src/gateway/http/server.js";
import { GatewaySessionRegistry } from "../src/gateway/session-service.js";
import {
  createGatewayUpgradeHandler,
  resolveGatewayMaxTokens,
} from "../src/gateway/ws/connection.js";
import { CODEX_PROVIDER } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const roots: string[] = [];
let activeServer: GatewayHttpServer | null = null;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (openSockets.length > 0) openSockets.pop()?.close();
  if (activeServer !== null) {
    await activeServer.close();
    activeServer = null;
  }
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("resolveGatewayMaxTokens", () => {
  it("resolves the Codex subscription profile by its real name", () => {
    expect(resolveGatewayMaxTokens(CODEX_PROVIDER.name)).toBe(CODEX_PROVIDER.defaultMaxTokens);
  });

  it('never falls back to the never-registered "codex" alias', () => {
    expect(resolveGatewayMaxTokens("codex")).toBeNull();
  });

  it("resolves an ordinary registered provider name", () => {
    expect(resolveGatewayMaxTokens("ollama")).toBe(8192);
  });
});

const TOKEN = "t287-gateway-events-token";
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    content: "final",
    finishReason: "stop",
    toolCalls: [],
    reasoning: null,
    usage,
    providerData: null,
    ...overrides,
  };
}

type ScriptStep = (request: ModelRequest) => NormalizedResponse | Promise<NormalizedResponse>;

class ScriptedTransport implements ModelTransport {
  private call = 0;
  public constructor(private readonly script: readonly ScriptStep[]) {}
  async complete(request: ModelRequest): Promise<NormalizedResponse> {
    const step = this.script[this.call];
    this.call += 1;
    if (step === undefined) throw new Error("SCRIPT_EXHAUSTED");
    return await step(request);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Same shape as SqliteConversationRepository, minus the three optional
 * compaction members -- ConversationRuntime's own fail-open branch
 * (`"compaction.unsupported"`) is for a repository that never claimed the
 * capability, exactly like this one (mirrors the real-world RequestRepository,
 * src/server/service.ts). */
function nonCompactableRepository(inner: SqliteConversationRepository): ConversationRepository {
  return {
    createSession: (input) => {
      inner.createSession(input);
    },
    session: (id) => inner.session(id),
    loadMessages: (id) => inner.loadMessages(id),
    commitTurn: (commit) => {
      inner.commitTurn(commit);
    },
    commitUsage: (commit) => {
      inner.commitUsage(commit);
    },
    summary: (id) => inner.summary(id),
  };
}

interface StartServerOptions {
  readonly transportScript?: readonly ScriptStep[];
  readonly compactable?: boolean;
}

async function startServer(options: StartServerOptions = {}): Promise<{
  readonly server: GatewayHttpServer;
  readonly sessions: SessionRepository;
}> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-events-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const compactable = options.compactable ?? true;
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired: true, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: [],
    toolDefinitions: [],
    home: root,
    provider: "t287-gateway-events-provider",
    createModelTransport: () =>
      new ScriptedTransport(options.transportScript ?? [() => response()]),
    createConversationRepository: () => {
      const sqlite = new SqliteConversationRepository(sessions);
      return compactable ? sqlite : nonCompactableRepository(sqlite);
    },
    dispatchTool: () => Promise.resolve('{"ok":true}'),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: () => Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    onUpgrade,
  });
  activeServer = server;
  return { server, sessions };
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

interface EventFrame {
  readonly method: string;
  readonly params: {
    readonly type: string;
    readonly session_id: string;
    readonly payload: unknown;
  };
}

/** Drains frames off `ws` until (and including) `message.complete`; every
 * `event`-method frame collected along the way, in arrival order. */
async function drainTurnEvents(ws: WebSocket): Promise<EventFrame[]> {
  const events: EventFrame[] = [];
  for (;;) {
    const raw = JSON.parse(await nextMessage(ws)) as Readonly<Record<string, unknown>>;
    if (raw.method === "event") {
      const event = raw as unknown as EventFrame;
      events.push(event);
      if (event.params.type === "message.complete") return events;
      continue;
    }
  }
}

// 800 filler chars -> ceil(800/2.9) = 276 estimated text tokens per message
// (src/context/token-estimate.ts's TEXT_CHARS_PER_TOKEN) -- 20 turns (40
// messages) puts the full history well over any single-digit-thousand
// threshold, while the turn-aligned kept tail (last 4 turns/8 messages by
// default, DEFAULT_MIN_KEEP_MESSAGES) stays comfortably under it.
function seedLongHistory(sessions: SessionRepository, sessionId: string): void {
  sessions.createSession({
    id: sessionId,
    source: "gateway",
    model: "gpt-5",
    systemPrompt: "seed",
    cwd: "/tmp",
  });
  const filler = "x".repeat(800);
  for (let turn = 0; turn < 20; turn += 1) {
    sessions.recordTurn(sessionId, {
      user: { role: "user", content: `q${String(turn)} ${filler}` },
      assistant: { role: "assistant", content: `a${String(turn)} ${filler}`, finishReason: "stop" },
    });
  }
}

describe("gateway ws: compaction events reach the socket (issue #287)", () => {
  it('emits a "compaction.unsupported" event frame when the repository has no compaction capability', async () => {
    vi.stubEnv("LOHRA_CONTEXT_WINDOW", "4000");
    const { server, sessions } = await startServer({ compactable: false });
    const sessionId = "s-unsupported";
    seedLongHistory(sessions, sessionId);

    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    openSockets.push(ws);
    await nextMessage(ws); // gateway.ready
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompt.submit",
        params: { session_id: sessionId, text: "continue" },
      }),
    );
    await nextMessage(ws); // rpc-ok
    const events = await drainTurnEvents(ws);
    const unsupported = events.find((event) => event.params.type === "compaction.unsupported");
    expect(unsupported).toBeDefined();
    expect(unsupported?.params.session_id).toBe(sessionId);
    ws.close();
  });

  it('emits a "session.compacted" event frame carrying the fold summary when a turn compacts', async () => {
    vi.stubEnv("LOHRA_CONTEXT_WINDOW", "4000");
    const { server, sessions } = await startServer({
      compactable: true,
      transportScript: [
        () => response({ content: "recap" }), // the default summarizer's own call
        () => response({ content: "final answer" }), // the turn's own model call
      ],
    });
    const sessionId = "s-compacted";
    seedLongHistory(sessions, sessionId);

    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    openSockets.push(ws);
    await nextMessage(ws); // gateway.ready
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompt.submit",
        params: { session_id: sessionId, text: "continue" },
      }),
    );
    await nextMessage(ws); // rpc-ok
    const events = await drainTurnEvents(ws);
    const compacted = events.find((event) => event.params.type === "session.compacted");
    expect(compacted).toBeDefined();
    expect(compacted?.params.session_id).toBe(sessionId);
    const compactionPayload = compacted?.params.payload as
      { readonly summarizedCount: number; readonly keptCount: number } | undefined;
    expect(typeof compactionPayload?.summarizedCount).toBe("number");
    expect(typeof compactionPayload?.keptCount).toBe("number");
    const complete = events.find((event) => event.params.type === "message.complete");
    const completePayload = complete?.params.payload as { readonly status: string } | undefined;
    expect(completePayload?.status).toBe("complete");
    ws.close();
  });
});
