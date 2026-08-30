import { describe, expect, it } from "vitest";

import { decodeJsonRpcFrame, encodeJsonRpcFrame } from "../../src/gateway/rpc/frame.js";

describe("decodeJsonRpcFrame", () => {
  it("decodes a well-formed request, echoing id and params verbatim", () => {
    const decoded = decodeJsonRpcFrame('{"jsonrpc":"2.0","id":7,"method":"session.list","params":{}}');
    expect(decoded).toEqual({ ok: true, id: 7, method: "session.list", params: {} });
  });

  it("-32700 on malformed JSON, id:null, message prefixed exactly 'parse error: '", () => {
    const decoded = decodeJsonRpcFrame("{nope");
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected failure");
    expect(decoded.response.id).toBeNull();
    expect(decoded.response.error.code).toBe(-32700);
    expect(decoded.response.error.message.startsWith("parse error: ")).toBe(true);
  });

  it("-32700 on an empty string", () => {
    const decoded = decodeJsonRpcFrame("");
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected failure");
    expect(decoded.response.error.code).toBe(-32700);
  });

  it("-32700 when a frame carries two JSON documents (extra data)", () => {
    const decoded = decodeJsonRpcFrame('{"jsonrpc":"2.0","id":1,"method":"session.list"}\n{}');
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected failure");
    expect(decoded.response.error.code).toBe(-32700);
  });

  it("tolerates a single trailing newline on an otherwise valid request", () => {
    const decoded = decodeJsonRpcFrame('{"jsonrpc":"2.0","id":1,"method":"session.list"}\n');
    expect(decoded).toEqual({ ok: true, id: 1, method: "session.list", params: {} });
  });

  it.each([["[]"], ["1"], ['"x"'], ["null"]])(
    "-32600 'request must be a JSON object' for top-level %s, id:null",
    (topLevel) => {
      const decoded = decodeJsonRpcFrame(topLevel);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("expected failure");
      expect(decoded.response.id).toBeNull();
      expect(decoded.response.error).toEqual({
        code: -32600,
        message: "request must be a JSON object",
      });
    },
  );

  it.each([
    ['{"id":1}', 1],
    ['{"id":1,"method":null}', 1],
    ['{"id":1,"method":""}', 1],
    ['{"id":1,"method":5}', 1],
    ['{"id":"str-id","method":null}', "str-id"],
  ])("-32600 'missing or invalid method' for %s, echoing id", (body, expectedId) => {
    const decoded = decodeJsonRpcFrame(body);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected failure");
    expect(decoded.response.id).toBe(expectedId);
    expect(decoded.response.error).toEqual({
      code: -32600,
      message: "missing or invalid 'method'",
    });
  });

  it.each([['{"id":1,"method":"m","params":[]}'], ['{"id":1,"method":"m","params":"x"}']])(
    "-32602 'params must be an object' for non-object params: %s",
    (body) => {
      const decoded = decodeJsonRpcFrame(body);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("expected failure");
      expect(decoded.response.id).toBe(1);
      expect(decoded.response.error).toEqual({
        code: -32602,
        message: "'params' must be an object",
      });
    },
  );

  it("treats params:null as an empty object", () => {
    const decoded = decodeJsonRpcFrame('{"id":1,"method":"m","params":null}');
    expect(decoded).toEqual({ ok: true, id: 1, method: "m", params: {} });
  });

  it("ignores the jsonrpc field entirely -- missing or wrong version both succeed", () => {
    expect(decodeJsonRpcFrame('{"id":1,"method":"m"}')).toEqual({
      ok: true,
      id: 1,
      method: "m",
      params: {},
    });
    expect(decodeJsonRpcFrame('{"jsonrpc":"1.0","id":1,"method":"m"}')).toEqual({
      ok: true,
      id: 1,
      method: "m",
      params: {},
    });
  });

  it("treats a request with no id key as a notification -- id:null on the decoded shape", () => {
    const decoded = decodeJsonRpcFrame('{"method":"session.list"}');
    expect(decoded).toEqual({ ok: true, id: null, method: "session.list", params: {} });
  });

  it("echoes an object id verbatim", () => {
    const decoded = decodeJsonRpcFrame('{"id":{"a":1},"method":"m"}');
    expect(decoded).toEqual({ ok: true, id: { a: 1 }, method: "m", params: {} });
  });

  it("ignores extra top-level keys", () => {
    const decoded = decodeJsonRpcFrame('{"id":1,"method":"m","extra":"ignored"}');
    expect(decoded).toEqual({ ok: true, id: 1, method: "m", params: {} });
  });

  it("does not trim or case-fold the method name", () => {
    const decoded = decodeJsonRpcFrame('{"id":1,"method":" session.list "}');
    expect(decoded).toEqual({ ok: true, id: 1, method: " session.list ", params: {} });
  });
});

describe("encodeJsonRpcFrame", () => {
  it("serializes compactly, no spaces after , or :", () => {
    const text = encodeJsonRpcFrame({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });
    expect(text).toBe('{"jsonrpc":"2.0","id":1,"result":{"sessions":[]}}');
  });
});
