import { describe, expect, it } from "vitest";

import {
  decodeRequest,
  decodeResult,
  encodeRequest,
  encodeResult,
  MAX_OUTPUT_BYTES,
  type HelperRequest,
  type HelperResult,
} from "../scripts/subprocess/windows-helper/protocol.js";

const request: HelperRequest = {
  executable: "C:\\Program Files\\node.exe",
  argv: ["npm cli.js", "say \"hi\"", "& | % ;", "東京"],
  cwd: "C:\\space & 東京",
  env: [["MARKER", "emoji 🐈 & space"]],
  timeoutMs: 300,
  cleanupMs: 2_000,
  stdoutLimitBytes: 1_024,
  stderrLimitBytes: 2_048,
};

const result: HelperResult = {
  outcome: "exited",
  pid: 23,
  status: 7,
  containmentConfirmed: true,
  faultCode: null,
  stdout: Uint8Array.of(0, 255, 0xe2, 0x82),
  stderr: Uint8Array.of(0, 1, 0xff),
};

function replaced(frame: Uint8Array, offset: number, byte: number): Uint8Array {
  const copy = Uint8Array.from(frame);
  copy[offset] = byte;
  return copy;
}

describe("Windows npm helper wire protocol", () => {
  it("round-trips literal request metadata and does not mutate its input", () => {
    const snapshot = JSON.stringify(request);
    expect(decodeRequest(encodeRequest(request))).toEqual(request);
    expect(JSON.stringify(request)).toBe(snapshot);
  });

  it("round-trips independent binary stdout/stderr without decoding incomplete UTF-8", () => {
    expect(decodeResult(encodeResult(result))).toEqual(result);
  });

  it("rejects unknown version, wrong kind, short and extra frames", () => {
    const frame = encodeRequest(request);
    expect(() => decodeRequest(replaced(frame, 3, 2))).toThrow(/VERSION/);
    expect(() => decodeResult(frame)).toThrow(/KIND/);
    expect(() => decodeRequest(frame.subarray(0, frame.length - 1))).toThrow(/TRUNCATED/);
    expect(() => decodeRequest(Uint8Array.from([...frame, 0]))).toThrow(/EXTRA/);
  });

  it("rejects malformed UTF-8 metadata and NUL intended for native APIs", () => {
    expect(() => encodeRequest({ ...request, argv: ["bad\0argument"] })).toThrow(/NUL/);
    const frame = encodeRequest({ ...request, executable: "X" });
    // Header=9, first string length=4, first byte of executable=13.
    expect(() => decodeRequest(replaced(frame, 13, 0xff))).toThrow(/UTF8/);
  });

  it("bounds request counts, numbers and output before allocation", () => {
    expect(() => encodeRequest({ ...request, argv: Array(1_025).fill("x") })).toThrow(/COUNT/);
    expect(() => encodeRequest({ ...request, timeoutMs: -1 })).toThrow(/LIMIT/);
    expect(() => encodeRequest({ ...request, stdoutLimitBytes: MAX_OUTPUT_BYTES + 1 })).toThrow(
      /LIMIT/,
    );
    const frame = encodeRequest(request);
    expect(() => decodeRequest(replaced(frame, 9, 0xff))).toThrow(/LENGTH/);
  });

  it("rejects conflicting result status, fault and containment", () => {
    expect(() => encodeResult({ ...result, containmentConfirmed: false })).toThrow(/CONTAINMENT/);
    expect(() => encodeResult({ ...result, faultCode: "ERR" })).toThrow(/FAULT/);
    expect(() => encodeResult({ ...result, outcome: "timeout", status: 0 })).toThrow(/STATUS/);
    expect(() => encodeResult({ ...result, outcome: "timeout", status: null })).toThrow(/FAULT/);
  });

  it("retains causal faults and refuses output beyond the declared limit", () => {
    const timed: HelperResult = {
      ...result,
      outcome: "timeout",
      status: null,
      faultCode: "ETIMEDOUT",
    };
    expect(decodeResult(encodeResult(timed))).toEqual(timed);
    expect(() => encodeResult({ ...result, stdout: new Uint8Array(MAX_OUTPUT_BYTES + 1) })).toThrow(
      /OUTPUT/,
    );
  });
});
