import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  pythonFloat,
  pythonJsonLoads,
  pythonJsonDumps,
  pythonJsonDumpsInsertionOrder,
} from "../src/serialization/python-json.js";

function pythonLines(source: string): readonly string[] {
  const result = spawnSync(process.env.PYTHON ?? "python3", ["-c", source], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "python json.dumps probe failed");
  return result.stdout.trimEnd().split("\n");
}

describe("Python-compatible JSON serializer", () => {
  it("sorts object keys without sorting arrays and uses Python separators", () => {
    expect(pythonJsonDumps({ z: 1, a: [{ z: 2, a: 3 }, "first"] })).toBe(
      '{"a": [{"a": 3, "z": 2}, "first"], "z": 1}',
    );
  });

  it("can preserve insertion order for Python json.dumps storage columns", () => {
    expect(pythonJsonDumpsInsertionOrder({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"z": 1, "a": {"y": 2, "b": 3}}',
    );
  });

  it("escapes BMP and non-BMP Unicode with lowercase surrogate escapes", () => {
    expect(pythonJsonDumps({ text: "café — 😀" })).toBe(
      '{"text": "caf\\u00e9 \\u2014 \\ud83d\\ude00"}',
    );
  });

  it("sorts non-BMP object keys by Unicode code point like Python", () => {
    expect(pythonJsonDumps({ "😀": 2, "": 1 })).toBe('{"\\ue000": 1, "\\ud83d\\ude00": 2}');
  });

  it("matches json.dumps across the ASCII boundary and adjacent Unicode", () => {
    const expected = pythonLines(
      'import json\nfor code in range(0x110): print(json.dumps({"c": chr(code)}, sort_keys=True))',
    );
    const actual = Array.from({ length: 0x110 }, (_, code) =>
      pythonJsonDumps({ c: String.fromCodePoint(code) }),
    );
    expect(actual).toEqual(expected);
  });

  it("matches json.dumps float formatting with explicit numeric intent", () => {
    const values = [1, -0, 1e15, 1e16, 9_999_999_999_999_998, 0.0001, 1e-5, 1e-7];
    const expected = pythonLines(
      'import json\nfor value in [1.0, -0.0, 1e15, 1e16, 9999999999999998.0, 0.0001, 1e-5, 1e-7]: print(json.dumps({"n": value}, sort_keys=True))',
    );
    expect(values.map((value) => pythonJsonDumps({ n: pythonFloat(value) }))).toEqual(expected);
    expect(pythonJsonDumps({ n: 1 })).toBe('{"n": 1}');
    for (const ambiguous of [-0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pythonJsonDumps({ n: ambiguous })).toThrow(/pythonFloat/);
    }
  });

  it("loads JSON numeric tokens with Python int/float identity at every depth", () => {
    const loaded = pythonJsonLoads(
      '{"integer":7,"whole":1.0,"nested":{"exponent":1e2},"array":[3.0,4]}',
    );
    expect(pythonJsonDumpsInsertionOrder(loaded)).toBe(
      '{"integer": 7, "whole": 1.0, "nested": {"exponent": 100.0}, "array": [3.0, 4]}',
    );
  });
});
