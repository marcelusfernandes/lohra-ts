import { describe, expect, it } from "vitest";

import { isPythonFalsy, isPythonTruthy } from "../src/server/python-truthy.js";

describe("isPythonFalsy / isPythonTruthy", () => {
  it("treats None/False/0/''/[]/{} as falsy", () => {
    for (const value of [null, undefined, false, 0, "", [], {}]) {
      expect(isPythonFalsy(value)).toBe(true);
      expect(isPythonTruthy(value)).toBe(false);
    }
  });

  it("treats a non-empty string like 'yes' as truthy (assertion 27)", () => {
    expect(isPythonTruthy("yes")).toBe(true);
    expect(isPythonTruthy("no")).toBe(true); // Python truthiness, not boolean parsing
  });

  it("treats non-empty collections and true/nonzero numbers as truthy", () => {
    expect(isPythonTruthy([0])).toBe(true);
    expect(isPythonTruthy({ include_usage: true })).toBe(true);
    expect(isPythonTruthy(true)).toBe(true);
    expect(isPythonTruthy(1)).toBe(true);
  });
});
