import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openStateDatabase, SessionRepository } from "../../src/state/index.js";
import { SqliteConversationRepository } from "../../src/conversation/index.js";
import type { ModelRequest, ModelTransport } from "../../src/conversation/types.js";
import type { NormalizedResponse, ToolCall } from "../../src/transports/index.js";
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

const TOKEN = "the-prompt-submit-token";
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
  close() {
    return Promise.resolve();
  }
}

interface StartServerOptions {
  readonly transportScript?: readonly ScriptStep[];
  readonly toolDispatch?: (name: string, argumentsJson: string) => Promise<string>;
}

async function startServer(options: StartServerOptions = {}): Promise<{
  readonly server: GatewayHttpServer;
  readonly home: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "lohra-gateway-prompt-submit-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  const registry = new GatewaySessionRegistry(sessions);
  const onUpgrade = createGatewayUpgradeHandler({
    registry,
    auth: { authRequired: true, expectedToken: TOKEN },
    sessionDefaults: { model: "gpt-5", systemPrompt: "sp", cwd: "/tmp" },
    toolNames: ["read_file"],
    toolDefinitions: [],
    home: root,
    provider: "test-provider",
    createModelTransport: () =>
      new ScriptedTransport(options.transportScript ?? [() => response()]),
    createConversationRepository: () => new SqliteConversationRepository(sessions),
    dispatchTool: options.toolDispatch ?? (() => Promise.resolve('{"ok":true}')),
  });
  const server = await startGatewayHttpServer({
    host: "127.0.0.1",
    port: 0,
    onRequest: () => Promise.resolve(jsonResponse(404, { detail: "Not Found" })),
    onUpgrade,
  });
  activeServer = server;
  return { server, home: root };
}

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

describe("prompt.submit: unknown/missing session_id (assertion 31)", () => {
  it("-32602 unknown session_id for a session that was never created", async () => {
    const { server } = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws);
    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: "nope", text: "hi" } }),
    );
    const response_ = JSON.parse(await nextMessage(ws)) as { error: { code: number; message: string } };
    expect(response_.error).toEqual({ code: -32602, message: "unknown session_id" });
    ws.close();
  });

  it("-32602 unknown session_id when session_id is missing entirely", async () => {
    const { server } = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { text: "hi" } }));
    const response_ = JSON.parse(await nextMessage(ws)) as { error: { code: number; message: string } };
    expect(response_.error).toEqual({ code: -32602, message: "unknown session_id" });
    ws.close();
  });
});

describe("prompt.submit: successful turn frame order and usage (assertions 33-35)", () => {
  it("rpc-ok -> message.start -> message.delta* -> message.complete{status:complete, usage:{}}", async () => {
    const { server } = await startServer({
      transportScript: [
        (request) => {
          request.onText?.("hel");
          request.onText?.("lo");
          return response({ content: "hello" });
        },
      ],
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    const rpcOk = JSON.parse(await nextMessage(ws)) as { id: number; result: { status: string } };
    expect(rpcOk).toEqual({ jsonrpc: "2.0", id: 9, result: { status: "streaming" } });

    const frames: { params: { type: string; payload: unknown } }[] = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(JSON.parse(await nextMessage(ws)) as { params: { type: string; payload: unknown } });
    }
    expect(frames.map((f) => f.params.type)).toEqual([
      "message.start",
      "message.delta",
      "message.delta",
      "message.complete",
    ]);
    expect(frames[1]?.params.payload).toEqual({ text: "hel" });
    expect(frames[2]?.params.payload).toEqual({ text: "lo" });
    expect(frames[3]?.params.payload).toEqual({ text: "hello", status: "complete", usage: {} });

    ws.close();
  });
});

describe("prompt.submit: tool call emits tool.start/tool.complete with dual serialization", () => {
  it("emits tool.start then tool.complete around the dispatch, before message.complete", async () => {
    const toolCall: ToolCall = { id: "call_1", name: "read_file", arguments: '{"path":"/x"}', providerData: null };
    const { server } = await startServer({
      transportScript: [
        () => response({ content: null, finishReason: "tool_calls", toolCalls: [toolCall] }),
        () => response({ content: "after tool" }),
      ],
      toolDispatch: () => Promise.resolve('{"ok":true,"data":"x"}'),
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    await nextMessage(ws); // rpc-ok
    const frames: { params: { type: string; payload: unknown } }[] = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(JSON.parse(await nextMessage(ws)) as { params: { type: string; payload: unknown } });
    }
    expect(frames.map((f) => f.params.type)).toEqual([
      "message.start",
      "tool.start",
      "tool.complete",
      "message.complete",
    ]);
    expect((frames[1]?.params.payload as { tool_id: string }).tool_id).toBe("tool_1");
    expect((frames[2]?.params.payload as { tool_id: string }).tool_id).toBe("tool_1");
    expect(frames[3]?.params.payload).toEqual({ text: "after tool", status: "complete", usage: {} });

    ws.close();
  });
});

describe("prompt.submit: busy session (assertion 31/47)", () => {
  it("a second prompt.submit on the same session while busy gets {code:4009}", async () => {
    let releaseFirstCall: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      releaseFirstCall = resolvePromise;
    });
    const { server } = await startServer({
      transportScript: [
        async () => {
          await gate;
          return response();
        },
      ],
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    await nextMessage(ws); // rpc-ok for first submit
    await nextMessage(ws); // message.start for first submit

    const secondWs = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws?token=${TOKEN}`);
    await nextMessage(secondWs);
    secondWs.send(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hi again" } }),
    );
    const busyResponse = JSON.parse(await nextMessage(secondWs)) as { error: { code: number; message: string } };
    expect(busyResponse.error).toEqual({ code: 4009, message: "session busy" });

    releaseFirstCall?.();
    ws.close();
    secondWs.close();
  });
});

describe("prompt.submit: mid-turn interrupt from a second socket (assertion 45/L19)", () => {
  it("interrupt during a tool-calling turn aborts before the next iteration -- {status:interrupted}, second iteration's model call never runs", async () => {
    let secondIterationCalls = 0;
    const ref: { sessionId: string | undefined; server: GatewayHttpServer | undefined } = {
      sessionId: undefined,
      server: undefined,
    };
    const toolCall: ToolCall = { id: "call_1", name: "read_file", arguments: "{}", providerData: null };

    const { server } = await startServer({
      transportScript: [
        () => response({ content: null, finishReason: "tool_calls", toolCalls: [toolCall] }),
        () => {
          secondIterationCalls += 1;
          return response({ content: "should never be observed" });
        },
      ],
      toolDispatch: async () => {
        // Fire the interrupt from a genuinely different socket WHILE the
        // tool call from iteration 1 is "in flight" -- by the time the
        // runtime loop checks signal.aborted at the top of iteration 2,
        // it must already be true.
        const port = ref.server?.port;
        const sessionId = ref.sessionId;
        if (port === undefined || sessionId === undefined) throw new Error("test setup race");
        const interruptSocket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${TOKEN}`);
        await nextMessage(interruptSocket); // gateway.ready
        interruptSocket.send(
          JSON.stringify({ jsonrpc: "2.0", id: "interrupt", method: "session.interrupt", params: { session_id: sessionId } }),
        );
        await nextMessage(interruptSocket); // {ok:true}
        interruptSocket.close();
        return '{"ok":true}';
      },
    });
    ref.server = server;
    const { ws, sessionId } = await connectAndCreateSession(server);
    ref.sessionId = sessionId;

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    await nextMessage(ws); // rpc-ok
    const frames: { params: { type: string; payload: unknown } }[] = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(JSON.parse(await nextMessage(ws)) as { params: { type: string; payload: unknown } });
    }
    expect(frames.map((f) => f.params.type)).toEqual([
      "message.start",
      "tool.start",
      "tool.complete",
      "message.complete",
    ]);
    expect(frames[3]?.params.payload).toEqual({ text: "", status: "interrupted", usage: {} });
    expect(secondIterationCalls).toBe(0);

    ws.close();
  });
});

describe("prompt.submit: same-socket serialization (assertion 46/L19)", () => {
  it("session.list sent on the SAME socket mid-stream is answered only after message.complete", async () => {
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      releaseTurn = resolvePromise;
    });
    const { server } = await startServer({
      transportScript: [
        async () => {
          await gate;
          return response();
        },
      ],
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    // Same socket, sent immediately after -- must queue behind the whole
    // streaming turn, not interleave with message.start/delta/complete.
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.list", params: {} }));

    const seenTypes: string[] = [];
    // rpc-ok for prompt.submit, then message.start arrive while the
    // transport is still gated -- session.list must NOT have been answered
    // yet at this point, proving it queued behind the in-flight turn.
    for (let i = 0; i < 2; i += 1) {
      const frame = JSON.parse(await nextMessage(ws)) as { id?: unknown; params?: { type: string } };
      seenTypes.push(frame.params?.type ?? `rpc:${String(frame.id)}`);
    }
    releaseTurn?.();
    const completeFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string } };
    seenTypes.push(completeFrame.params.type);
    const listResponse = JSON.parse(await nextMessage(ws)) as { id: number; result: { sessions: unknown[] } };
    expect(listResponse.id).toBe(2);
    expect(seenTypes).toEqual(["rpc:1", "message.start", "message.complete"]);

    ws.close();
  });
});

describe("prompt.submit: idle interrupt latch (assertion 44/L16)", () => {
  it("interrupt on an idle session makes the next prompt.submit complete with zero upstream calls", async () => {
    let transportCalls = 0;
    const { server } = await startServer({
      transportScript: [
        () => {
          transportCalls += 1;
          return response();
        },
      ],
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.interrupt", params: { session_id: sessionId } }));
    const interruptResult = JSON.parse(await nextMessage(ws)) as { result: { ok: boolean } };
    expect(interruptResult.result.ok).toBe(true);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    await nextMessage(ws); // rpc-ok
    const startFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string } };
    const completeFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string; payload: unknown } };
    expect(startFrame.params.type).toBe("message.start");
    expect(completeFrame.params.type).toBe("message.complete");
    expect(completeFrame.params.payload).toEqual({ text: "", status: "interrupted", usage: {} });
    expect(transportCalls).toBe(0);

    ws.close();
  });
});

describe("prompt.submit: ghost turn (ADR-T12-02, non-string text)", () => {
  it.each([[5], [{ a: 1 }], [null]])(
    "text=%j -> rpc-ok + message.start, then permanent silence; cause logged to a file, not stderr",
    async (badText) => {
      const { server, home } = await startServer();
      const { ws, sessionId } = await connectAndCreateSession(server);

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "prompt.submit",
          params: { session_id: sessionId, text: badText },
        }),
      );
      await nextMessage(ws); // rpc-ok
      const startFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string } };
      expect(startFrame.params.type).toBe("message.start");

      // No further frame arrives -- prove silence with a bounded race
      // against a timeout instead of waiting forever.
      const raced = await Promise.race([
        nextMessage(ws).then(() => "message"),
        new Promise<string>((resolvePromise) => setTimeout(() => { resolvePromise("timeout"); }, 200)),
      ]);
      expect(raced).toBe("timeout");

      const logPath = join(home, "logs", "gateway.log");
      const logContent = readFileSync(logPath, "utf8");
      expect(logContent).toContain("ghost-turn");
      expect(logContent).toContain(sessionId);

      ws.close();
    },
  );

  it("the session lock is released after a ghost turn -- the next prompt.submit on the same session works", async () => {
    const { server } = await startServer();
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: 5 } }),
    );
    await nextMessage(ws); // rpc-ok
    await nextMessage(ws); // message.start

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    const rpcOk = JSON.parse(await nextMessage(ws)) as { id: number; result: { status: string } };
    expect(rpcOk.id).toBe(2);
    const startFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string } };
    const completeFrame = JSON.parse(await nextMessage(ws)) as { params: { type: string; payload: unknown } };
    expect(startFrame.params.type).toBe("message.start");
    expect(completeFrame.params.payload).toEqual({ text: "final", status: "complete", usage: {} });

    ws.close();
  });
});

describe("prompt.submit: upstream error (assertion 53/L21)", () => {
  it("message.complete{status:error, warning} instead of a separate error event", async () => {
    const { server } = await startServer({
      transportScript: [
        () => {
          throw new Error("upstream exploded");
        },
      ],
    });
    const { ws, sessionId } = await connectAndCreateSession(server);

    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { session_id: sessionId, text: "hi" } }),
    );
    await nextMessage(ws); // rpc-ok
    await nextMessage(ws); // message.start
    const completeFrame = JSON.parse(await nextMessage(ws)) as {
      params: { type: string; payload: { status: string; warning: string; text: string; usage: unknown } };
    };
    expect(completeFrame.params.type).toBe("message.complete");
    expect(completeFrame.params.payload.status).toBe("error");
    expect(completeFrame.params.payload.text).toBe("");
    expect(completeFrame.params.payload.usage).toEqual({});
    expect(completeFrame.params.payload.warning).toContain("upstream exploded");

    ws.close();
  });
});
