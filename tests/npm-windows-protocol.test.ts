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
  argv: ["npm cli.js", 'say "hi"', "& | % ;", "東京"],
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
  fault: null,
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

  it("preserves an initial U+FEFF in each literal metadata position", () => {
    const withBom: HelperRequest = {
      ...request,
      executable: "\ufeffnode.exe",
      cwd: "\ufeffcwd",
      argv: ["\ufeffarg"],
      env: [["\ufeffKEY", "\ufeffvalue"]],
    };
    expect(decodeRequest(encodeRequest(withBom))).toEqual(withBom);
  });

  it("round-trips independent binary stdout/stderr without decoding incomplete UTF-8", () => {
    expect(decodeResult(encodeResult(result))).toEqual(result);
  });

  it("fixes little-endian golden frames for a future .NET Framework consumer", () => {
    const minimal: HelperRequest = {
      executable: "N",
      argv: [],
      cwd: "C",
      env: [],
      timeoutMs: 0,
      cleanupMs: 1,
      stdoutLimitBytes: 1,
      stderrLimitBytes: 1,
    };
    const requestHex =
      "4c4e50010122000000010000004e0100000043000000000000000000000000010000000100000001000000";
    expect(Buffer.from(encodeRequest(minimal)).toString("hex")).toBe(requestHex);
    expect(decodeRequest(Buffer.from(requestHex, "hex"))).toEqual(minimal);
    const exited: HelperResult = {
      outcome: "exited",
      pid: 1,
      status: 0xffff_ffff,
      containmentConfirmed: true,
      fault: null,
      stdout: Uint8Array.of(0, 255),
      stderr: Uint8Array.of(1),
    };
    const resultHex = "4c4e50010215000000000701000000ffffffff0200000000ff0100000001";
    expect(Buffer.from(encodeResult(exited)).toString("hex")).toBe(resultHex);
    expect(decodeResult(Buffer.from(resultHex, "hex"))).toEqual(exited);
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
    expect(() => encodeRequest({ ...request, cwd: "lone\ud800" })).toThrow(/UTF8/);
    expect(() => encodeRequest({ ...request, env: [["BAD=KEY", "value"]] })).toThrow(/ENV/);
    const frame = encodeRequest({ ...request, executable: "X" });
    // Header=9, first string length=4, first byte of executable=13.
    expect(() => decodeRequest(replaced(frame, 13, 0xff))).toThrow(/UTF8/);
  });

  it("bounds request counts, numbers and output before allocation", () => {
    expect(() => encodeRequest({ ...request, argv: Array(1_025).fill("x") })).toThrow(/COUNT/);
    expect(() => encodeRequest({ ...request, timeoutMs: -1 })).toThrow(/LIMIT/);
    expect(() => encodeRequest({ ...request, cleanupMs: 0 })).toThrow(/LIMIT/);
    expect(() => encodeRequest({ ...request, cleanupMs: 60_001 })).toThrow(/LIMIT/);
    expect(() => encodeRequest({ ...request, executable: "x".repeat(16_385) })).toThrow(/LENGTH/);
    expect(() => encodeRequest({ ...request, stdoutLimitBytes: MAX_OUTPUT_BYTES + 1 })).toThrow(
      /LIMIT/,
    );
    const frame = encodeRequest(request);
    const oversized = Uint8Array.from(frame);
    oversized[9] = 0xff;
    oversized[10] = 0xff;
    expect(() => decodeRequest(oversized)).toThrow(/LENGTH/);
  });

  it("accepts exact count and time boundaries without mutating input", () => {
    const boundary: HelperRequest = {
      ...request,
      argv: Array(1_024).fill("x"),
      env: Array.from({ length: 512 }, (_, index) => [`K${String(index)}`, "v"] as const),
      timeoutMs: 0,
      cleanupMs: 60_000,
      stdoutLimitBytes: MAX_OUTPUT_BYTES,
      stderrLimitBytes: MAX_OUTPUT_BYTES,
    };
    expect(decodeRequest(encodeRequest(boundary))).toEqual(boundary);
    expect(() => encodeRequest({ ...boundary, env: [...boundary.env, ["EXTRA", "x"]] })).toThrow(
      /COUNT/,
    );
    expect(boundary.env).toHaveLength(512);
  });

  it("rejects conflicting result status, fault and containment", () => {
    expect(() => encodeResult({ ...result, containmentConfirmed: false })).toThrow(/CONTAINMENT/);
    expect(() =>
      encodeResult({ ...result, fault: { phase: "run", code: "ERR", nativeCode: null } }),
    ).toThrow(/FAULT/);
    expect(() => encodeResult({ ...result, outcome: "timeout", status: 0 })).toThrow(/STATUS/);
    expect(() => encodeResult({ ...result, outcome: "timeout", status: null })).toThrow(/FAULT/);
  });

  it("retains causal faults and refuses output beyond the declared limit", () => {
    const timed: HelperResult = {
      ...result,
      outcome: "timeout",
      status: null,
      fault: { phase: "run", code: "ETIMEDOUT", nativeCode: null },
    };
    expect(decodeResult(encodeResult(timed))).toEqual(timed);
    expect(() =>
      encodeResult({ ...timed, fault: { phase: "run", code: "bad message", nativeCode: null } }),
    ).toThrow(/FAULT/);
    expect(() => encodeResult({ ...result, stdout: new Uint8Array(MAX_OUTPUT_BYTES + 1) })).toThrow(
      /OUTPUT/,
    );
    const frame = encodeResult(result);
    expect(() => decodeResult(replaced(frame, 9, 255))).toThrow(/OUTCOME/);
    expect(() => decodeResult(replaced(frame, 10, 0x17))).toThrow(/FLAGS/);
    expect(() => decodeResult(frame.subarray(0, frame.length - 1))).toThrow(/TRUNCATED/);
    expect(() => decodeResult(Uint8Array.from([...frame, 0]))).toThrow(/EXTRA/);
    const hugeOutput = Uint8Array.from(frame);
    // Header + outcome/flags + pid/status = 19; stdout length begins there.
    hugeOutput[21] = 1;
    hugeOutput[22] = 4;
    expect(() => decodeResult(hugeOutput)).toThrow(/OUTPUT/);
  });

  it("keeps sensitive metadata out of protocol errors", () => {
    const secret = "SENSITIVE_MARKER_ONLY_IN_INPUT";
    try {
      encodeRequest({ ...request, env: [["SECRET", secret]], argv: ["bad\0argument"] });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe("NPM_HELPER_PROTOCOL:NUL");
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => encodeResult({ ...result, pid: null })).toThrow(/PID/);
  });
});
