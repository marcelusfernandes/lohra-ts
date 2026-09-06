import { stringifyJsonPreservingNumbers } from "../../serialization/json-numbers.js";

export type JsonRpcId = string | number | boolean | null | Readonly<Record<string, unknown>>;

export interface DecodedJsonRpcRequest {
  readonly ok: true;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string };
}

export interface DecodeFailure {
  readonly ok: false;
  readonly response: JsonRpcErrorResponse;
}

export type DecodedJsonRpcFrame = DecodedJsonRpcRequest | DecodeFailure;

function errorFrame(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A single trailing newline is tolerated (the oracle's json.loads ignores
// it); anything else after the first JSON value -- including a second
// document in the same frame -- fails the same way malformed JSON does,
// because JSON.parse rejects it as a syntax error either way.
export function decodeJsonRpcFrame(text: string): DecodedJsonRpcFrame {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, response: errorFrame(null, -32700, `parse error: ${detail}`) };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      response: errorFrame(null, -32600, "request must be a JSON object"),
    };
  }

  const rawId = "id" in parsed ? (parsed.id as JsonRpcId) : null;
  const method = parsed.method;
  if (typeof method !== "string" || method.length === 0) {
    return {
      ok: false,
      response: errorFrame(rawId, -32600, "missing or invalid 'method'"),
    };
  }

  const rawParams = "params" in parsed ? parsed.params : undefined;
  if (rawParams !== undefined && rawParams !== null && !isPlainObject(rawParams)) {
    return {
      ok: false,
      response: errorFrame(rawId, -32602, "'params' must be an object"),
    };
  }

  return {
    ok: true,
    id: rawId,
    method,
    params: isPlainObject(rawParams) ? rawParams : {},
  };
}

// The outer WS frame is always compact + non-ASCII-literal
// (WebSocket.send_json / ensure_ascii=False on the oracle). Any spaced or
// escaped-non-ASCII text -- args_text, result -- must already be a plain
// *string* value inside this frame, produced by a caller that used the
// inner (spaced/escaped) convention explicitly; this function never
// re-derives that distinction on its own.
export function encodeJsonRpcFrame(frame: unknown): string {
  return stringifyJsonPreservingNumbers(frame);
}

export type GatewayEventName =
  | "gateway.ready"
  | "session.info"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "tool.start"
  | "tool.complete"
  | "session.forked";

export function encodeGatewayEventFrame(
  type: GatewayEventName,
  sessionId: string | null,
  payload: object,
): string {
  return encodeJsonRpcFrame({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, payload },
  });
}
