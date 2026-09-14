// Issue #608 (AC4, épico #575 "toda superfície"): the WS gateway
// (`src/gateway/ws/connection.ts`) is the one production `ConversationRuntime`
// construction site under `src/gateway/**` that never wired the operator-
// notices overlay (issue #589) — `commands/chat.ts`/`commands/dashboard.ts`'s
// own cron-job runtime already did. `GatewayWsDeps.notices` is optional
// (absent means byte-identical to every pre-#608 gateway turn, same
// convention as `ConversationRuntimeOptions.notices` itself). Issue #651
// wired `dashboard.ts` (the only production caller) to populate it on every
// real WS turn — `tests/gateway/dashboard-ws-overlay.test.ts` proves THAT
// caller; this file proves the MECHANISM `createGatewayUpgradeHandler` offers
// via a fake port constructed directly here, same harness as
// `tests/gateway/prompt-submit.test.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { SqliteConversationRepository } from "../../src/conversation/index.js";
import type {
  ModelRequest,
  ModelTransport,
  TurnNoticesClaim,
  TurnNoticesPort,
} from "../../src/conversation/index.js";
import type { NormalizedResponse } from "../../src/transports/index.js";
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

const TOKEN = "the-ws-notices-token";
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class RecordingTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    // A plain spread, not structuredClone: request.onText (always present --
    // the gateway always streams) is a function, which structuredClone
    // cannot serialize.
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    return Promise.resolve({
      content: "final",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage,
      providerData: null,
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeNotices implements TurnNoticesPort {
  ackCalls: (readonly number[])[] = [];
  private readonly claimResult: TurnNoticesClaim;
  constructor(claimResult: TurnNoticesClaim) {
    this.claimResult = claimResult;
  }
  claim(): TurnNoticesClaim {
    return this.claimResult;
  }
  ack(token: readonly number[]): void {
    this.ackCalls.push(token);
  }
  publishFailure(): void {
    // unused in this test
  }
}

async function startServer(notices?: TurnNoticesPort): Promise<{
  readonly server: GatewayHttpServer;
  readonly transport: RecordingTransport;
}> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-ws-notices-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const transport = new RecordingTransport();
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired: true, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: [],
    toolDefinitions: [],
    home: root,
    provider: "test-provider",
    createModelTransport: () => transport,
    createConversationRepository: () => new SqliteConversationRepository(sessions),
    dispatchTool: () => Promise.reject(new Error("no tool dispatch exercised in this test")),
    ...(notices === undefined ? {} : { notices }),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: () => Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    onUpgrade,
  });
  activeServer = server;
  return { server, transport };
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

async function connectAndCreateSession(
  server: GatewayHttpServer,
): Promise<{ readonly ws: WebSocket; readonly sessionId: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
  await nextMessage(ws); // gateway.ready
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: "create", method: "session.create", params: {} }));
  const createResult = JSON.parse(await nextMessage(ws)) as { result: { session_id: string } };
  await nextMessage(ws); // session.info
  return { ws, sessionId: createResult.result.session_id };
}

describe("GatewayWsDeps.notices (#608 AC4)", () => {
  it("attaches the claimed overlay to the user message of a prompt.submit turn, and acks it after completion", async () => {
    const notices = new FakeNotices({
      token: [42],
      overlay: "OPERATOR NOTICES (not the user speaking):\n- [unknown] a pending gateway notice",
    });
    const { server, transport } = await startServer(notices);
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompt.submit",
        params: { session_id: sessionId, text: "hello from the gateway" },
      }),
    );
    await nextMessage(ws); // rpc ok
    await nextMessage(ws); // message.start
    await nextMessage(ws); // message.complete

    const sentUser = transport.requests[0]?.messages.find((message) => message.role === "user");
    expect(sentUser?.content).toContain("a pending gateway notice");
    expect(sentUser?.content).toContain("hello from the gateway");
    expect(notices.ackCalls).toEqual([[42]]);
    ws.close();
  });

  it("is byte-identical to a turn without deps.notices when it is absent (pre-#608 behavior unchanged)", async () => {
    const { server, transport } = await startServer(undefined);
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompt.submit",
        params: { session_id: sessionId, text: "hello from the gateway" },
      }),
    );
    await nextMessage(ws);
    await nextMessage(ws);
    await nextMessage(ws);

    const sentUser = transport.requests[0]?.messages.find((message) => message.role === "user");
    expect(sentUser?.content).toBe("hello from the gateway");
    ws.close();
  });
});
