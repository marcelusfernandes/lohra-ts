import { describe, expect, it } from "vitest";

import {
  buildToolCompletePayload,
  buildToolStartPayload,
} from "../../src/gateway/rpc/tool-event-payload.js";
import { encodeGatewayEventFrame } from "../../src/gateway/rpc/frame.js";
import {
  jsonStringifyPythonNumbers,
  pythonJsonDumpsInsertionOrder,
} from "../../src/serialization/python-json.js";

// Golden fixture from the T12 baseline (evidence-s06-tools.json / T12
// baseline §2 L8): a single frame carries two serialization conventions --
// the outer WS frame is compact + literal non-ASCII (WebSocket.send_json),
// while args_text/result (JSON embedded as a *string* field) are spaced +
// escaped, matching Python's json.dumps default. This is the trap: a
// candidate using one serializer for the whole frame breaks it invisibly
// to any test that only does JSON.parse-and-compare-objects.
const NON_ASCII_PATH = "/não-existe-ção";

describe("tool.start / tool.complete dual serialization", () => {
  it("tool.start: args_text is spaced + escaped inside a compact + literal outer frame (byte-exact)", () => {
    const argsObject = { path: NON_ASCII_PATH };
    const payload = buildToolStartPayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: JSON.stringify(argsObject),
    });

    // Independently derive the expected bytes from the pre-existing,
    // already-tested serializer primitives -- not from the code under test.
    const expectedArgsText = pythonJsonDumpsInsertionOrder(argsObject);
    const expectedFrame = jsonStringifyPythonNumbers({
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

    // Sanity checks on the intermediate value itself, matching the exact
    // baseline byte sequence for this fixture.
    expect(expectedArgsText).toBe('{"path": "/n\\u00e3o-existe-\\u00e7\\u00e3o"}');
    // The outer frame is compact (no ", " / ": ") and non-ASCII is literal.
    expect(frame).not.toContain(", ");
    expect(frame).toContain('"session_id":"sess"');
  });

  it("tool.complete: args is compact + literal, result is spaced + escaped (byte-exact)", () => {
    const argsObject = { path: NON_ASCII_PATH };
    const resultObject = { error: `file not found: ${NON_ASCII_PATH}` };
    const payload = buildToolCompletePayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: JSON.stringify(argsObject),
      resultJson: JSON.stringify(resultObject),
    });

    const expectedResultText = pythonJsonDumpsInsertionOrder(resultObject);
    const expectedFrame = jsonStringifyPythonNumbers({
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
    expect(expectedResultText).toBe(
      '{"error": "file not found: /n\\u00e3o-existe-\\u00e7\\u00e3o"}',
    );
    // args is embedded with literal (non-escaped) non-ASCII, matching
    // ensure_ascii=False on the outer frame.
    expect(frame).toContain('"args":{"path":"/não-existe-ção"}');
  });

  it("a single-serializer mutant (JSON.stringify for args_text too) diverges from the golden", () => {
    const argsObject = { path: NON_ASCII_PATH };
    const naive = JSON.stringify(argsObject);
    const correct = buildToolStartPayload({
      toolId: "tool_1",
      name: "read_file",
      argumentsJson: JSON.stringify(argsObject),
    }).args_text;
    expect(naive).not.toBe(correct);
  });

  it("message.delta text is literal non-ASCII on the wire, not escaped", () => {
    const frame = encodeGatewayEventFrame("message.delta", "sess", {
      text: "olá münchen 日本語 ✅",
    });
    expect(frame).toContain('"text":"olá münchen 日本語 ✅"');
    expect(frame).not.toContain("\\u");
  });
});
