import type { Socket } from "node:net";
import type { IncomingMessage } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { timingSafeTokenEqual } from "../auth.js";
import type { ParsedRequestHead } from "../http/request-parser.js";
import type { GatewaySessionRegistry } from "../session-service.js";
import { dispatchSyncRpc, type SessionDefaults } from "../rpc/dispatch.js";
import { decodeJsonRpcFrame, encodeGatewayEventFrame, encodeJsonRpcFrame } from "../rpc/frame.js";

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
}

function fakeIncomingMessage(head: ParsedRequestHead): IncomingMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of head.headers) headers[name.toLowerCase()] = value;
  return { headers, method: head.method, url: head.path } as unknown as IncomingMessage;
}

function handleTextMessage(
  ws: WebSocket,
  sessionId: string | null,
  text: string,
  deps: GatewayWsDeps,
): void {
  const decoded = decodeJsonRpcFrame(text);
  if (!decoded.ok) {
    ws.send(encodeJsonRpcFrame(decoded.response));
    return;
  }

  const outcome = dispatchSyncRpc(deps.registry, decoded.method, decoded.params, deps.sessionDefaults);
  if (outcome.kind === "unhandled") {
    // prompt.submit -- the async streaming turn path. Not wired yet in this
    // slice (deferred per the coordinator's streaming-last ordering); left
    // silent is wrong long-term, but there is nothing to route it to until
    // that slice lands, and this is an internal build-out gap, not oracle
    // behavior to reproduce.
    return;
  }
  if (outcome.kind === "error") {
    ws.send(encodeJsonRpcFrame({ jsonrpc: "2.0", id: decoded.id, error: { code: outcome.code, message: outcome.message } }));
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
  void sessionId;
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

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          // A single binary frame kills the socket with no close frame, no
          // code, no error -- reproduced deliberately (L6, assertion 24).
          ws.terminate();
          return;
        }
        handleTextMessage(ws, null, Buffer.from(data as Buffer).toString("utf8"), deps);
      });
    });
  };
}
