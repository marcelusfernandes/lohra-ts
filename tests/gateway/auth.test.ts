import { describe, expect, it } from "vitest";

import { generateSessionToken, timingSafeTokenEqual } from "../../src/gateway/auth.js";

describe("generateSessionToken", () => {
  it("mints a 43-character urlsafe token, matching secrets.token_urlsafe(32)", () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mints a fresh token on every call", () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe("timingSafeTokenEqual", () => {
  it("returns true only for an exact match", () => {
    expect(timingSafeTokenEqual("abc", "abc")).toBe(true);
    expect(timingSafeTokenEqual("abc", "abd")).toBe(false);
  });

  it("returns false for differing lengths without throwing", () => {
    expect(timingSafeTokenEqual("abc", "abcd")).toBe(false);
    expect(timingSafeTokenEqual("abcd", "abc")).toBe(false);
  });

  it("returns false for an empty candidate against a non-empty expected value", () => {
    expect(timingSafeTokenEqual("", "abc")).toBe(false);
  });

  it("rejects a value with trailing OWS even when the trimmed form matches", () => {
    expect(timingSafeTokenEqual("abc  ", "abc")).toBe(false);
  });

  it("accepts a value equal after only leading OWS was stripped by the parser", () => {
    // The parser already strips leading OWS before this function ever runs;
    // timingSafeTokenEqual itself never trims anything.
    expect(timingSafeTokenEqual("abc", "abc")).toBe(true);
  });
});
