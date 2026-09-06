import { describe, expect, it } from "vitest";

import { hasJsonValue, isEmptyJsonValue } from "../src/serialization/json-presence.js";

describe("isEmptyJsonValue / hasJsonValue", () => {
  it("treats None/False/0/''/[]/{} as empty", () => {
    for (const value of [null, undefined, false, 0, "", [], {}]) {
      expect(isEmptyJsonValue(value)).toBe(true);
      expect(hasJsonValue(value)).toBe(false);
    }
  });

  it("treats a non-empty string like 'yes' as present (assertion 27)", () => {
    expect(hasJsonValue("yes")).toBe(true);
    expect(hasJsonValue("no")).toBe(true); // presence rule, not boolean parsing
  });

  it("treats non-empty collections and true/nonzero numbers as present", () => {
    expect(hasJsonValue([0])).toBe(true);
    expect(hasJsonValue({ include_usage: true })).toBe(true);
    expect(hasJsonValue(true)).toBe(true);
    expect(hasJsonValue(1)).toBe(true);
  });
});
