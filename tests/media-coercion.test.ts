import { describe, expect, it } from "vitest";

import { coerceInt, isPresentMediaValue } from "../src/media/coercion.js";

describe("isPresentMediaValue", () => {
  it.each([undefined, null, false, NaN, 0, 0n, "", []])(
    "treats %s as absent (media-truthy false)",
    (value) => {
      expect(isPresentMediaValue(value)).toBe(false);
    },
  );

  it("treats an empty object as absent", () => {
    expect(isPresentMediaValue({})).toBe(false);
  });

  it.each([true, 1, -1, 1n, -1n, "0", " ", [1], { a: 1 }])(
    "treats %s as present (media-truthy true)",
    (value) => {
      expect(isPresentMediaValue(value)).toBe(true);
    },
  );

  it("treats Infinity as present, unlike NaN", () => {
    expect(isPresentMediaValue(Infinity)).toBe(true);
    expect(isPresentMediaValue(-Infinity)).toBe(true);
  });
});

describe("coerceInt", () => {
  it("coerces booleans to 0/1", () => {
    expect(coerceInt(false)).toBe(0);
    expect(coerceInt(true)).toBe(1);
  });

  it("truncates finite numbers toward zero", () => {
    expect(coerceInt(1.9)).toBe(1);
    expect(coerceInt(-1.9)).toBe(-1);
  });

  it("rejects non-finite numbers", () => {
    expect(coerceInt(NaN)).toBeUndefined();
    expect(coerceInt(Infinity)).toBeUndefined();
  });

  it("parses plain optional-sign integer strings only", () => {
    expect(coerceInt("2")).toBe(2);
    expect(coerceInt("+2")).toBe(2);
    expect(coerceInt("-2")).toBe(-2);
    expect(coerceInt("1.9")).toBeUndefined();
    expect(coerceInt("2x")).toBeUndefined();
    expect(coerceInt("")).toBeUndefined();
  });

  it("rejects everything else", () => {
    expect(coerceInt(null)).toBeUndefined();
    expect(coerceInt(undefined)).toBeUndefined();
    expect(coerceInt({})).toBeUndefined();
  });
});
