import { describe, expect, it } from "vitest";

import {
  buildToolCompletePayload,
  buildToolStartPayload,
} from "../../src/gateway/rpc/tool-event-payload.js";
import { encodeGatewayEventFrame } from "../../src/gateway/rpc/frame.js";
import { stringifyJsonPreservingNumbers } from "../../src/serialization/json-numbers.js";

// Issue #71 / docs/adr/0003-native-wire-format.md, "JSON output" item 1: the
// outer WS frame and the embedded args_text/args/result string fields now
// share ONE convention — compact, insertion order, UTF-8 direct (no
// \uXXXX). The pre-#71 baseline had two conventions on purpose (outer frame
// compact + literal, args_text/result spaced + \u-escaped, matching Python
// json.dumps); that split is gone by design, not by omission.
const NON_ASCII_PATH = "/não-existe-ção";

describe("tool.start / tool.complete: one serializer, compact + literal, everywhere", () => {
  it("tool.start: args_text and the outer frame use the same compact, UTF-8-direct format", () => {
    const argsObject = { path: NON_ASCII_PATH };
    const payload = buildToolStartPayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: JSON.stringify(argsObject),
    });

    // Independently derive the expected bytes from the already-tested
    // serializer primitive -- not from the code under test.
    const expectedArgsText = stringifyJsonPreservingNumbers(argsObject);
    const expectedFrame = stringifyJsonPreservingNumbers({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.start",
        session_id: "sess",
        payload: { tool_id: "tool_1", name: "read_file", args_text: expectedArgsText },
      },
    });

    const frame = encodeGatewayEventFrame("tool.start", "sess", payload);
    expect(frame).toBe(expectedFrame);

    expect(expectedArgsText).toBe('{"path":"/não-existe-ção"}');
    // Compact everywhere (no ", " / ": ") and non-ASCII is literal UTF-8.
    expect(frame).not.toContain(", ");
    expect(frame).not.toContain("\\u");
    expect(frame).toContain('"session_id":"sess"');
  });

  it("tool.complete: args and result use the same compact, UTF-8-direct format", () => {
    const argsObject = { path: NON_ASCII_PATH };
    const resultObject = { error: `file not found: ${NON_ASCII_PATH}` };
    const payload = buildToolCompletePayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: JSON.stringify(argsObject),
      resultJson: JSON.stringify(resultObject),
    });

    const expectedResultText = stringifyJsonPreservingNumbers(resultObject);
    const expectedFrame = stringifyJsonPreservingNumbers({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.complete",
        session_id: "sess",
        payload: {
          tool_id: "tool_1",
          name: "read_file",
          args: argsObject,
          result: expectedResultText,
        },
      },
    });

    const frame = encodeGatewayEventFrame("tool.complete", "sess", payload);
    expect(frame).toBe(expectedFrame);
    expect(expectedResultText).toBe('{"error":"file not found: /não-existe-ção"}');
    expect(frame).toContain('"args":{"path":"/não-existe-ção"}');
    expect(frame).not.toContain("\\u");
  });

  it("normalizes non-canonical input JSON, proving the parse-and-re-encode step still does work", () => {
    // A mutant that passes `argumentsJson` straight through (instead of
    // parsing and re-encoding via stringifyJsonPreservingNumbers) would
    // leak the input's own spacing/formatting into args_text. Feeding
    // spaced, non-canonical JSON in and asserting compact JSON comes out
    // proves the normalization step still runs.
    const correct = buildToolStartPayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: '{ "path" : "x" }',
    }).args_text;
    expect(correct).toBe('{"path":"x"}');
  });

  it("message.delta text is literal non-ASCII on the wire, not escaped", () => {
    const frame = encodeGatewayEventFrame("message.delta", "sess", {
      text: "olá münchen 日本語 ✅",
    });
    expect(frame).toContain('"text":"olá münchen 日本語 ✅"');
    expect(frame).not.toContain("\\u");
  });
});
