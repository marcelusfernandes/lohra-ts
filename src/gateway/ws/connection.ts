import type { Socket } from "node:net";
import type { IncomingMessage } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { ConversationRuntime } from "../../conversation/index.js";
import type {
  ConversationRepository,
  ConversationRuntimeEvent,
  ModelTransport,
} from "../../conversation/types.js";
import { getProviderProfileIncludingCodex } from "../../providers/index.js";
import type { ToolDefinition } from "../../tools/types.js";
import { timingSafeTokenEqual } from "../auth.js";
import { logGatewayFailure } from "../failure-log.js";
import type { ParsedRequestHead } from "../http/request-parser.js";
import type { GatewaySessionRegistry } from "../session-service.js";
import { GatewayEventingToolDispatcher, driveGatewayTurn } from "../turn.js";
import { dispatchSyncRpc, type SessionDefaults } from "../rpc/dispatch.js";
import {
  decodeJsonRpcFrame,
  encodeGatewayEventFrame,
  encodeJsonRpcFrame,
  type JsonRpcId,
} from "../rpc/frame.js";

const WS_PATH = "/api/ws";

// Documented-and-absent / internal WS endpoints (T12 baseline L3/L22): all
// 403 Forbidden at the HTTP level, WITHOUT checking auth at all -- an
// unauthenticated route-enumeration surface, reproduced deliberately.
const FORBIDDEN_WS_PATHS: ReadonlySet<string> = new Set([
  "/api/websocket",
  "/api/ws/",
  "/api/pty",
  "/api/pub",
  "/api/events",
]);

function splitPathAndQuery(rawPath: string): { readonly path: string; readonly query: string } {
  const index = rawPath.indexOf("?");
  return index < 0
    ? { path: rawPath, query: "" }
    : { path: rawPath.slice(0, index), query: rawPath.slice(index + 1) };
}

// Query token multiplicity: the LAST value wins (opposite of the REST
// header, where the first duplicate wins) -- assertion 20.
function lastQueryToken(query: string): string | null {
  const params = new URLSearchParams(query);
  const values = params.getAll("token");
  return values.length === 0 ? null : (values[values.length - 1] as string);
}

function write403(socket: Socket): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

// Issue #287 (revisor round 2 of PR #284): a bare `getProviderProfile
// (deps.provider)` used to return null for the Codex subscription route
// (`dashboard.ts` passed the string literal "codex", which is not a
// registered provider alias, and even the real name "openai-codex" isn't
// registered either -- CODEX_PROVIDER is deliberately absent from the
// registry, see its own comment in src/providers/registry.ts) --
// `maxTokens` silently fell back to `null`/0 and the compaction preflight's
// reserved-output budget for the Codex route was wrong.
// `getProviderProfileIncludingCodex` resolves it by its real name. Exported
// (not just inlined) so this resolution can be pinned directly, without a
// full subscription-mode dashboard harness.
export function resolveGatewayMaxTokens(provider: string): number | null {
  return getProviderProfileIncludingCodex(provider)?.defaultMaxTokens ?? null;
}

// Mirrors encodeGatewayEventFrame's exact wire shape (../rpc/frame.ts) for
// the two compaction event types ConversationRuntimeEvent emits (issue
// #287) that a production caller never forwarded before. `GatewayEventName`
// there is a closed string-literal union `frame.ts` isn't in this issue's
// `Files` to widen -- this is the minimal way to reach the identical frame
// shape without touching a caller that has no reason to know these two
// event types exist.
function encodeCompactionEventFrame(
  type: "session.compacted" | "compaction.unsupported",
  sessionId: string,
  payload: object,
): string {
  return encodeJsonRpcFrame({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, payload },
  });
}

export interface GatewayAuthConfig {
  readonly authRequired: boolean;
  readonly expectedToken: string;
}

function isAuthorized(query: string, auth: GatewayAuthConfig): boolean {
  if (!auth.authRequired) return true;
  const presented = lastQueryToken(query);
  if (presented === null) return false;
  return timingSafeTokenEqual(presented, auth.expectedToken);
}

export interface GatewayWsDeps {
  readonly registry: GatewaySessionRegistry;
  readonly auth: GatewayAuthConfig;
  readonly sessionDefaults: SessionDefaults;
  readonly toolNames: readonly string[];
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly home: string;
  readonly provider: string;
  readonly createModelTransport: () => ModelTransport;
  readonly createConversationRepository: () => ConversationRepository;
  readonly dispatchTool: (name: string, argumentsJson: string) => Promise<string>;
}

function fakeIncomingMessage(head: ParsedRequestHead): IncomingMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of head.headers) headers[name.toLowerCase()] = value;
  return { headers, method: head.method, url: head.path } as unknown as IncomingMessage;
}

// prompt.submit is the one RPC that streams a whole turn's worth of events
// instead of a single result -- everything else in dispatchSyncRpc answers
// in one shot. Handled separately here because it needs the socket (to
// stream message.start/tool.*/message.delta/message.complete) and the
// per-turn wiring (fresh transport + runtime + tool dispatcher) that a pure
// sync dispatcher has no business owning.
async function handlePromptSubmit(
  ws: WebSocket,
  rpcId: JsonRpcId,
  params: Readonly<Record<string, unknown>>,
  deps: GatewayWsDeps,
): Promise<void> {
  const sessionId = typeof params.session_id === "string" ? params.session_id : undefined;
  if (sessionId === undefined) {
    ws.send(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: rpcId,
        error: { code: -32602, message: "unknown session_id" },
      }),
    );
    return;
  }
  const rejection = deps.registry.promptSubmissionRejection(sessionId);
  if (rejection !== null) {
    if (rejection === "subsession") {
      logGatewayFailure(deps.home, {
        kind: "security",
        cause: "SUBSESSION_PRIVILEGE_PROMOTION_DENIED",
        sessionId,
      });
    }
    ws.send(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: rpcId,
        error: {
          code: -32602,
          message:
            rejection === "subsession"
              ? "subsession cannot be promoted to a gateway session"
              : "unknown session_id",
        },
      }),
    );
    return;
  }

  if (deps.registry.isBusy(sessionId)) {
    ws.send(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: rpcId,
        error: { code: 4009, message: "session busy" },
      }),
    );
    return;
  }

  // Idle interrupt latch (L16): a session.interrupt on an idle session
  // consumes here -- the following prompt.submit completes with zero
  // upstream calls and nothing persisted, before ever touching the runtime.
  if (deps.registry.consumeInterruptLatch(sessionId)) {
    ws.send(encodeJsonRpcFrame({ jsonrpc: "2.0", id: rpcId, result: { status: "streaming" } }));
    ws.send(encodeGatewayEventFrame("message.start", sessionId, {}));
    ws.send(
      encodeGatewayEventFrame("message.complete", sessionId, {
        text: "",
        status: "interrupted",
        usage: {},
      }),
    );
    return;
  }

  ws.send(encodeJsonRpcFrame({ jsonrpc: "2.0", id: rpcId, result: { status: "streaming" } }));
  ws.send(encodeGatewayEventFrame("message.start", sessionId, {}));

  const rawText = params.text;
  if (typeof rawText !== "string") {
    // ADR-T12-02 / ADR-T13-07: the ghost turn. rpc-ok + message.start
    // already sent; permanent silence on this socket for this request from
    // here on -- no message.complete, no error, no close. The cause is
    // logged to a file, never stdout/stderr (those are byte-fixed
    // elsewhere). The session lock still releases via the finally-equivalent
    // below, so the NEXT prompt.submit on this session works normally.
    logGatewayFailure(deps.home, {
      kind: "ghost-turn",
      sessionId,
      textType: typeof rawText,
      message: `user_message must be str, got ${typeof rawText}`,
    });
    return;
  }

  deps.registry.markBusy(sessionId);
  const controller = deps.registry.beginTurn(sessionId);
  try {
    const dispatcher = new GatewayEventingToolDispatcher(deps.dispatchTool, {
      onToolStart: (payload) => {
        ws.send(encodeGatewayEventFrame("tool.start", sessionId, payload));
      },
      onToolComplete: (payload) => {
        ws.send(encodeGatewayEventFrame("tool.complete", sessionId, payload));
      },
    });
    // maxTokens reserves the compaction preflight's output budget (issue
    // #252, compactionThreshold, src/conversation/compaction.ts) --
    // without it (absent here before this fix, unlike commands/chat.ts and
    // commands/dashboard.ts's own cron job runtime, both of which already
    // pass profile.defaultMaxTokens) the preflight let a request through
    // with zero room reserved for the response. resolveGatewayMaxTokens is
    // null-safe: an unregistered provider name (defensive only -- every
    // real GatewayWsDeps.provider names a provider dashboard.ts already
    // resolved to build deps.createModelTransport()) just leaves the
    // reserve at ConversationRuntime's own default (0), same as before --
    // but the Codex subscription route ("openai-codex") now resolves to
    // its real profile instead of silently falling through (issue #287).
    const runtime = new ConversationRuntime({
      repository: deps.createConversationRepository(),
      transport: deps.createModelTransport(),
      promptSnapshot: () => deps.sessionDefaults.systemPrompt,
      toolDispatcher: dispatcher,
      toolDefinitions: deps.toolDefinitions,
      idSource: () => sessionId,
      clock: () => Date.now() / 1000,
      maxTokens: resolveGatewayMaxTokens(deps.provider),
      // Issue #287: forwards the two compaction events onto the socket as
      // `event` frames (encodeCompactionEventFrame above) -- before this,
      // `session.compacted`/`compaction.unsupported` only ever reached a
      // test's own fake sink, never a real gateway ws client. Every other
      // ConversationRuntimeEvent type is ignored here on purpose: this
      // socket already has its own dedicated frames for turn/model
      // progress (message.start/delta/complete, tool.start/complete).
      eventSink: (event: ConversationRuntimeEvent) => {
        if (event.type === "session.compacted") {
          ws.send(
            encodeCompactionEventFrame(
              "session.compacted",
              event.sessionId,
              event.compaction ?? {},
            ),
          );
        } else if (event.type === "compaction.unsupported") {
          ws.send(encodeCompactionEventFrame("compaction.unsupported", event.sessionId, {}));
        }
      },
    });

    const outcome = await driveGatewayTurn({
      runtime,
      sessionId,
      text: rawText,
      provider: deps.provider,
      model: deps.sessionDefaults.model,
      cwd: deps.sessionDefaults.cwd,
      signal: controller.signal,
      onDelta: (text) => {
        ws.send(encodeGatewayEventFrame("message.delta", sessionId, { text }));
      },
    });

    if (outcome.status === "complete") {
      ws.send(
        encodeGatewayEventFrame("message.complete", sessionId, {
          text: outcome.text,
          status: "complete",
          usage: {},
        }),
      );
    } else if (outcome.status === "interrupted") {
      ws.send(
        encodeGatewayEventFrame("message.complete", sessionId, {
          text: "",
          status: "interrupted",
          usage: {},
        }),
      );
    } else {
      ws.send(
        encodeGatewayEventFrame("message.complete", sessionId, {
          text: "",
          status: "error",
          usage: {},
          warning: outcome.warning,
        }),
      );
    }
  } finally {
    deps.registry.endTurn(sessionId);
    deps.registry.clearBusy(sessionId);
  }
}

async function handleTextMessage(ws: WebSocket, text: string, deps: GatewayWsDeps): Promise<void> {
  const decoded = decodeJsonRpcFrame(text);
  if (!decoded.ok) {
    ws.send(encodeJsonRpcFrame(decoded.response));
    return;
  }

  if (decoded.method === "prompt.submit") {
    await handlePromptSubmit(ws, decoded.id, decoded.params, deps);
    return;
  }

  const outcome = dispatchSyncRpc(
    deps.registry,
    decoded.method,
    decoded.params,
    deps.sessionDefaults,
  );
  if (outcome.kind === "unhandled") return;
  if (outcome.kind === "error") {
    ws.send(
      encodeJsonRpcFrame({
        jsonrpc: "2.0",
        id: decoded.id,
        error: { code: outcome.code, message: outcome.message },
      }),
    );
    return;
  }
  ws.send(encodeJsonRpcFrame({ jsonrpc: "2.0", id: decoded.id, result: outcome.result }));
  if (outcome.emitSessionInfoFor !== undefined) {
    const info = deps.registry.sessionInfo({
      model: deps.sessionDefaults.model,
      tools: deps.toolNames,
      running: false,
    });
    ws.send(encodeGatewayEventFrame("session.info", outcome.emitSessionInfoFor, info));
  }
}

export function createGatewayUpgradeHandler(
  deps: GatewayWsDeps,
): (head: ParsedRequestHead, socket: Socket, extra: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });

  return (head, socket, extra) => {
    const { path, query } = splitPathAndQuery(head.path);

    if (path !== WS_PATH || FORBIDDEN_WS_PATHS.has(path)) {
      write403(socket);
      return;
    }

    wss.handleUpgrade(fakeIncomingMessage(head), socket, extra, (ws) => {
      if (!isAuthorized(query, deps.auth)) {
        ws.close(4401, "");
        return;
      }

      ws.send(encodeGatewayEventFrame("gateway.ready", null, { skin: { name: "lohra" } }));

      // A socket is strictly serial (L19): the loop only reads the next
      // message after the current one's handling fully resolves. A naive
      // fire-and-forget "message" listener would process a session.list
      // sent mid-stream concurrently with prompt.submit instead of queuing
      // it behind message.complete -- chain each handler onto the previous
      // one instead of awaiting inside the listener itself (ws needs the
      // listener to return synchronously to keep receiving frames).
      let queue: Promise<void> = Promise.resolve();
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          // A single binary frame kills the socket with no close frame, no
          // code, no error -- reproduced deliberately (L6, assertion 24).
          ws.terminate();
          return;
        }
        const text = Buffer.from(data as Buffer).toString("utf8");
        queue = queue.then(() => handleTextMessage(ws, text, deps));
      });
    });
  };
}
