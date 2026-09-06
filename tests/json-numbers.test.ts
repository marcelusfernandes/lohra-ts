import { describe, expect, it } from "vitest";

import {
  jsonFloat,
  parseJsonPreservingNumbers,
  stringifyJsonPreservingNumbers,
} from "../src/serialization/json-numbers.js";

// Golden values below were derived once from the pre-extraction behaviour of
// `src/serialization/python-json.ts` (`pythonJsonLoads` /
// `jsonStringifyPythonNumbers`, now `parseJsonPreservingNumbers` /
// `stringifyJsonPreservingNumbers`) — no `python3`/`spawnSync` here, per
// issue #70 AC3. See docs/adr/0003-native-wire-format.md.
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

  it("accepts the NaN/Infinity/-Infinity literal extension on read", () => {
    const documents = [
      '{"v": NaN}',
      '{"v": Infinity}',
      '{"v": -Infinity}',
      "[NaN, Infinity, -Infinity]",
    ];
    const expected = ['{"v":NaN}', '{"v":Infinity}', '{"v":-Infinity}', "[NaN,Infinity,-Infinity]"];
    expect(
      documents.map((raw) => stringifyJsonPreservingNumbers(parseJsonPreservingNumbers(raw))),
    ).toEqual(expected);
  });

  it("rejects case/sign variants of the NaN/Infinity literals", () => {
    const rejected = ["nan", "inf", "+Infinity", "NAN", "Nan"];
    for (const raw of rejected) {
      expect(() => parseJsonPreservingNumbers(raw)).toThrow();
    }
  });
});
