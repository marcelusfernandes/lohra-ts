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
      expect(() => pythonJsonDumps({ n: ambiguous })).toThrow(/Ambiguous or unsafe number/);
    }
  });

  it("loads JSON numeric tokens with Python int/float identity at every depth", () => {
    const loaded = pythonJsonLoads(
      '{"integer":7,"safe_max":9007199254740991,"negative_zero":-0,"whole":1.0,"unsafe":9007199254740993,"nested":{"exponent":1e2,"huge":123456789012345678901234567890},"array":[3.0,4]}',
    );
    expect(pythonJsonDumpsInsertionOrder(loaded)).toBe(
      '{"integer": 7, "safe_max": 9007199254740991, "negative_zero": 0, "whole": 1.0, "unsafe": 9007199254740993, "nested": {"exponent": 100.0, "huge": 123456789012345678901234567890}, "array": [3.0, 4]}',
    );
  });

  it("loads the NaN/Infinity/-Infinity literal extension, cross-checked against real json.loads", () => {
    const documents = [
      '{"v": NaN}',
      '{"v": Infinity}',
      '{"v": -Infinity}',
      "[NaN, Infinity, -Infinity]",
    ];
    const expected = pythonLines(
      `import json\nfor raw in ${JSON.stringify(documents)}: print(json.dumps(json.loads(raw)))`,
    );
    expect(documents.map((raw) => pythonJsonDumpsInsertionOrder(pythonJsonLoads(raw)))).toEqual(
      expected,
    );
  });

  it("rejects case/sign variants of the NaN/Infinity literals, matching Python's exact sensitivity", () => {
    const rejected = ["nan", "inf", "+Infinity", "NAN", "Nan"];
    const pythonRejects = pythonLines(
      `import json
for raw in ${JSON.stringify(rejected)}:
    try:
        json.loads(raw)
        print("accepted")
    except json.JSONDecodeError:
        print("rejected")`,
    );
    expect(pythonRejects).toEqual(rejected.map(() => "rejected"));
    for (const raw of rejected) {
      expect(() => pythonJsonLoads(raw)).toThrow();
    }
  });

  it("round-trips arbitrary JSON integers exactly against Python", () => {
    const documents = [
      "9007199254740991",
      "9007199254740992",
      "9007199254740993",
      "-9007199254740993",
      "123456789012345678901234567890",
      "-123456789012345678901234567890",
      "-0",
      '{"nested":[9007199254740993,{"huge":123456789012345678901234567890}]}',
    ];
    const expected = pythonLines(
      `import json\nfor raw in ${JSON.stringify(documents)}: print(json.dumps(json.loads(raw)))`,
    );
    expect(documents.map((raw) => pythonJsonDumpsInsertionOrder(pythonJsonLoads(raw)))).toEqual(
      expected,
    );
  });
});
