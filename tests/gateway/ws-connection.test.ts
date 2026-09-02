import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { GatewaySessionRegistry } from "../../src/gateway/session-service.js";
import { createGatewayUpgradeHandler } from "../../src/gateway/ws/connection.js";
import { startGatewayHttpServer, type GatewayHttpServer } from "../../src/gateway/http/server.js";
import { jsonResponse } from "../../src/gateway/http/response.js";

const roots: string[] = [];
let activeServer: GatewayHttpServer | null = null;

afterEach(async () => {
  if (activeServer !== null) {
    await activeServer.close();
    activeServer = null;
  }
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const TOKEN = "the-expected-ws-token";

async function startServer(authRequired = true): Promise<GatewayHttpServer> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-ws-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: ["read_file"],
    toolDefinitions: [],
    home: root,
    provider: "test-provider",
    createModelTransport: () => {
      throw new Error("no prompt.submit exercised in this test file -- see turn.test.ts / dashboard-command.test.ts");
    },
    createConversationRepository: () => {
      throw new Error("no prompt.submit exercised in this test file -- see turn.test.ts / dashboard-command.test.ts");
    },
    dispatchTool: () => Promise.reject(new Error("no tool dispatch exercised in this test file")),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: () => Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    onUpgrade,
  });
  activeServer = server;
  return server;
}

// A naive ws.once("message", ...) per call races: if the server sends two
// frames back-to-back, both can arrive in the same TCP read and get
// delivered as two synchronous 'message' events in the same tick -- the
// second fires before the awaited first has resumed the async function to
// register the next .once() listener, so it's silently dropped. Queue
// every message from a single persistent listener instead, so ordering is
// preserved regardless of timing.
const messageQueues = new WeakMap<
  WebSocket,
  { readonly queue: string[]; readonly waiters: ((value: string) => void)[] }
>();

function queueFor(ws: WebSocket): { readonly queue: string[]; readonly waiters: ((value: string) => void)[] } {
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

interface GatewayEventFrame {
  readonly params: { readonly type: string; readonly session_id: string | null; readonly payload: unknown };
}

function parseEventFrame(text: string): GatewayEventFrame {
  return JSON.parse(text) as GatewayEventFrame;
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise) => {
    ws.once("close", (code, reason) => {
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
}

describe("gateway WS: handshake always completes to 101 (assertion 19)", () => {
  it("valid token: connects, then receives gateway.ready", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    const ready = JSON.parse(await nextMessage(ws)) as {
      params: { type: string; session_id: null; payload: unknown };
    };
    expect(ready.params.type).toBe("gateway.ready");
    expect(ready.params.session_id).toBeNull();
    ws.close();
  });

  it("missing/invalid token: upgrade still completes, then closes with 4401 empty reason", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws`);
    let opened = false;
    ws.once("open", () => {
      opened = true;
    });
    const closed = await waitClose(ws);
    expect(opened).toBe(true);
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe("");
  });
});

describe("gateway WS: query multiplicity (assertion 20)", () => {
  it("good then bad -> last wins -> rejected", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}&token=wrong`);
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4401);
  });

  it("bad then good -> last wins -> accepted", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=wrong&token=${TOKEN}`);
    const message = await nextMessage(ws);
    expect(parseEventFrame(message).params.type).toBe("gateway.ready");
    ws.close();
  });
});

describe("gateway WS: path sweep, forbidden at HTTP level (assertion 23)", () => {
  it.each(["/api/websocket", "/api/ws/", "/api/pty", "/api/pub", "/api/events"])(
    "%s -> 403 without a token, socket never upgrades",
    async (path) => {
      const server = await startServer();
      const raw = await new Promise<string>((resolvePromise) => {
        const socket = connect(server.port, "127.0.0.1", () => {
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("close", () => {
          resolvePromise(Buffer.concat(chunks).toString("binary"));
        });
      });
      expect(raw).toContain("HTTP/1.1 403 Forbidden\r\n");
    },
  );
});

describe("gateway WS: --insecure mode opens without a token", () => {
  it("no token in the query, WS still opens and emits gateway.ready", async () => {
    const server = await startServer(false);
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws`);
    const message = await nextMessage(ws);
    expect(parseEventFrame(message).params.type).toBe("gateway.ready");
    ws.close();
  });
});

describe("gateway WS: binary frame kills the socket with no close code (assertion 24)", () => {
  it("client observes an abrupt close, no close frame semantics, other behavior unaffected", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws); // gateway.ready
    const closed = waitClose(ws);
    ws.send(Buffer.from([1, 2, 3]));
    const result = await closed;
    // ws.terminate() on the server produces an abnormal closure on the
    // client side; there is no server-issued close code to check for.
    expect(result.code).not.toBe(1000);
  });
});

describe("gateway WS: RPC round trip over a real socket (assertions 27-32)", () => {
  it("session.create -> {session_id} + a session.info event, then session.list/history/interrupt", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws); // gateway.ready

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }));
    const createResult = JSON.parse(await nextMessage(ws)) as { result: { session_id: string } };
    const sessionId = createResult.result.session_id;
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);

    const infoFrame = JSON.parse(await nextMessage(ws)) as {
      params: { type: string; session_id: string; payload: unknown };
    };
    expect(infoFrame.params.type).toBe("session.info");
    expect(infoFrame.params.session_id).toBe(sessionId);

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.list", params: {} }));
    const listResult = JSON.parse(await nextMessage(ws)) as { result: { sessions: unknown[] } };
    expect(listResult.result.sessions).toHaveLength(1);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session.history",
        params: { session_id: sessionId },
      }),
    );
    const historyResult = JSON.parse(await nextMessage(ws)) as { result: { messages: unknown[] } };
    expect(historyResult.result.messages).toEqual([]);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "session.interrupt",
        params: { session_id: sessionId },
      }),
    );
    const interruptResult = JSON.parse(await nextMessage(ws)) as { result: { ok: boolean } };
    expect(interruptResult.result.ok).toBe(true);

    ws.close();
  });

  it("unknown method -> -32601", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.steer", params: {} }));
    const response = JSON.parse(await nextMessage(ws)) as { error: { code: number; message: string } };
    expect(response.error).toEqual({ code: -32601, message: "unknown method: session.steer" });
    ws.close();
  });

  it("malformed frame -> -32700 with id:null", async () => {
    const server = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws);
    ws.send("{nope");
    const response = JSON.parse(await nextMessage(ws)) as { id: null; error: { code: number } };
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
    ws.close();
  });
});
