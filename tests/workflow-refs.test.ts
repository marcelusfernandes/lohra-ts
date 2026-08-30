import { describe, expect, it } from "vitest";

import { pythonFloat } from "../src/serialization/python-json.js";
import {
  InvalidReferenceError,
  findRefs,
  invalidRefs,
  isValidRef,
  resolveStrict,
  resolveValue,
} from "../src/workflow/index.js";

describe("workflow refs", () => {
  it("supports Unicode Nd path segments but rejects superscripts", () => {
    expect(isValidRef("a.٣")).toBe(true);
    expect(isValidRef("a.²")).toBe(false);
    expect(findRefs("x=${a.٣}; y=${a.²}")).toEqual(["a.٣", "a.²"]);
    expect(invalidRefs("x=${a.٣}; y=${a.²}")).toEqual(["a.²"]);
    expect(resolveValue("${lst.١}", { lst: [7, 8, 9] })).toBe(8);
  });

  it.each(["${a.²}", "${a-b}", "${a b}", "${a+1}", "${}", "${lst.²}"])(
    "fails closed with a structured cause for invalid %s",
    (value) => {
      expect(() => resolveValue(value, { a: {}, lst: [1] })).toThrow(InvalidReferenceError);
      try {
        resolveValue(value, { a: {}, lst: [1] });
      } catch (error) {
        expect(error).toMatchObject({ code: "REF_INVALID" });
      }
    },
  );

  it("preserves whole types, walks values only and resolves once", () => {
    const context = { a: { b: { ok: true } }, inj: "${a.b}" };
    expect(resolveValue("  ${a.b}  ", context)).toEqual({ ok: true });
    expect(resolveValue("${inj}", context)).toBe("${a.b}");
    expect(resolveValue("x=${inj}", context)).toBe("x=${a.b}");
    expect(resolveValue({ "${a.b}": ["${a.b}"] }, context)).toEqual({
      "${a.b}": [{ ok: true }],
    });
  });

  it("uses Python-compatible numeric stringification", () => {
    expect(resolveValue("v=${num}", { num: pythonFloat(1) })).toBe("v=1.0");
    expect(resolveValue("v=${big}", { big: 12_345_678_901_234_567_890n })).toBe(
      "v=12345678901234567890",
    );
    expect(() => resolveValue("v=${unsafe}", { unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "pythonFloat",
    );
  });

  it("preserves Unicode when embedding non-string JSON values", () => {
    expect(resolveValue("v=${obj}", { obj: { label: "café" } })).toBe('v={"label": "café"}');
  });

  it("reports the first strict null without rescanning", () => {
    expect(resolveStrict("${a.missing}", { a: {} })).toEqual([null, "a.missing"]);
    expect(resolveStrict("x=${a.missing}; y=${b.missing}", { a: {}, b: {} })).toEqual([
      null,
      "a.missing",
    ]);
    expect(resolveStrict("x=${a.value}", { a: { value: "ok" } })).toEqual(["x=ok", null]);
  });
});
