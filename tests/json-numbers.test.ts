import { describe, expect, it } from "vitest";

import {
  jsonFloat,
  parseJsonPreservingNumbers,
  stringifyJsonPreservingNumbers,
} from "../src/serialization/json-numbers.js";

// Golden values below were derived once from the pre-extraction fidelity
// primitives this module replaces (issue #70) — no `python3`/`spawnSync`
// here, per issue #70 AC3. See docs/adr/0003-native-wire-format.md.
describe("JSON number fidelity", () => {
  it("preserves int/float identity at every depth", () => {
    const loaded = parseJsonPreservingNumbers(
      '{"integer":7,"safe_max":9007199254740991,"negative_zero":-0,"whole":1.0,"unsafe":9007199254740993,"nested":{"exponent":1e2,"huge":123456789012345678901234567890},"array":[3.0,4]}',
    );
    expect(stringifyJsonPreservingNumbers(loaded)).toBe(
      '{"integer":7,"safe_max":9007199254740991,"negative_zero":0,"whole":1.0,"unsafe":9007199254740993,"nested":{"exponent":100.0,"huge":123456789012345678901234567890},"array":[3.0,4]}',
    );
  });

  it("round-trips integers beyond Number.MAX_SAFE_INTEGER without loss", () => {
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
    const expected = [
      "9007199254740991",
      "9007199254740992",
      "9007199254740993",
      "-9007199254740993",
      "123456789012345678901234567890",
      "-123456789012345678901234567890",
      "0",
      '{"nested":[9007199254740993,{"huge":123456789012345678901234567890}]}',
    ];
    expect(
      documents.map((raw) => stringifyJsonPreservingNumbers(parseJsonPreservingNumbers(raw))),
    ).toEqual(expected);
  });

  it("formats floats with explicit numeric intent, distinct from bare integers", () => {
    expect(stringifyJsonPreservingNumbers({ n: jsonFloat(1) })).toBe('{"n":1.0}');
    expect(stringifyJsonPreservingNumbers({ n: jsonFloat(-0) })).toBe('{"n":-0.0}');
    expect(stringifyJsonPreservingNumbers([jsonFloat(1), jsonFloat(2.5)])).toBe("[1.0,2.5]");
    expect(stringifyJsonPreservingNumbers({ n: 1 })).toBe('{"n":1}');
  });

  it("accepts the NaN/Infinity/-Infinity literal extension on read (legacy/hand-edited files)", () => {
    const documents = ['{"v": NaN}', '{"v": Infinity}', '{"v": -Infinity}'];
    const results = documents.map((raw) => parseJsonPreservingNumbers(raw));
    expect(Number.isNaN((results[0] as { v: { value: number } }).v.value)).toBe(true);
    expect((results[1] as { v: { value: number } }).v.value).toBe(Number.POSITIVE_INFINITY);
    expect((results[2] as { v: { value: number } }).v.value).toBe(Number.NEGATIVE_INFINITY);
  });

  it("rejects case/sign variants of the NaN/Infinity literals", () => {
    const rejected = ["nan", "inf", "+Infinity", "NAN", "Nan"];
    for (const raw of rejected) {
      expect(() => parseJsonPreservingNumbers(raw)).toThrow();
    }
  });

  // docs/adr/0003-native-wire-format.md, "JSON output" item 4: a non-finite
  // number reaching a serialization boundary is a fault with a cause
  // (invariant 2), never a silent `null`/`NaN` byte. The writer never emits
  // these — read tolerance above is for legacy/hand-edited stores only.
  describe("non-finite numbers at the write boundary (issue #71 AC3)", () => {
    it("throws for a bare non-finite number, with the key path in the message", () => {
      expect(() => stringifyJsonPreservingNumbers({ a: { b: Number.NaN } })).toThrow(TypeError);
      expect(() => stringifyJsonPreservingNumbers({ a: { b: Number.NaN } })).toThrow(/a\.b/);
      expect(() => stringifyJsonPreservingNumbers([1, Number.POSITIVE_INFINITY])).toThrow(/\[1\]/);
      expect(() => stringifyJsonPreservingNumbers(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    });

    it("throws for a non-finite JsonFloat, not just bare numbers", () => {
      expect(() => stringifyJsonPreservingNumbers({ n: jsonFloat(Number.NaN) })).toThrow(TypeError);
      expect(() =>
        stringifyJsonPreservingNumbers({ n: jsonFloat(Number.POSITIVE_INFINITY) }),
      ).toThrow(TypeError);
      expect(() =>
        stringifyJsonPreservingNumbers({ n: jsonFloat(Number.NEGATIVE_INFINITY) }),
      ).toThrow(TypeError);
    });

    it("JSON.stringify would have silently swallowed this as `null` — this must not", () => {
      // The exact regression this AC guards against: a plain `number` typed
      // NaN reaching a serialization boundary must fault, not disappear.
      expect(JSON.stringify({ n: Number.NaN })).toBe('{"n":null}');
      expect(() => stringifyJsonPreservingNumbers({ n: Number.NaN })).toThrow();
    });
  });

  // docs/adr/0003-native-wire-format.md, "JSON output" items 1-3: insertion
  // order, UTF-8 direct (no \uXXXX for non-ASCII), JSON.stringify's own
  // default separators (compact) and its `null, 2` indent shape.
  describe("wire shape matches native JSON.stringify (issue #71 AC1/AC2)", () => {
    it("is byte-identical to JSON.stringify for values without JsonFloat/JsonInteger", () => {
      const sample = { z: 1, a: [{ z: 2, a: 3 }, "first", true, null] };
      expect(stringifyJsonPreservingNumbers(sample)).toBe(JSON.stringify(sample));
      expect(stringifyJsonPreservingNumbers(sample, 2)).toBe(JSON.stringify(sample, null, 2));
    });

    it("emits non-ASCII as literal UTF-8, never \\uXXXX escapes", () => {
      const value = { text: "café — 😀" };
      expect(stringifyJsonPreservingNumbers(value)).toBe('{"text":"café — 😀"}');
      expect(stringifyJsonPreservingNumbers(value)).not.toContain("\\u");
    });

    it("indented output uses two spaces and JSON.stringify's `: ` colon spacing", () => {
      expect(stringifyJsonPreservingNumbers({ a: 1, b: { c: 2 } }, 2)).toBe(
        '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
      );
    });

    it("keeps insertion order, never sorts keys", () => {
      expect(stringifyJsonPreservingNumbers({ z: 1, a: 2 })).toBe('{"z":1,"a":2}');
    });
  });
});
