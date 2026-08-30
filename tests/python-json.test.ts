import { describe, expect, it } from "vitest";

import { pythonJsonDumps } from "../src/serialization/python-json.js";

describe("Python-compatible JSON serializer", () => {
  it("sorts object keys without sorting arrays and uses Python separators", () => {
    expect(pythonJsonDumps({ z: 1, a: [{ z: 2, a: 3 }, "first"] })).toBe(
      '{"a": [{"a": 3, "z": 2}, "first"], "z": 1}',
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
});
