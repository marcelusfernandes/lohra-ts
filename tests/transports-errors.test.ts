import { describe, expect, it } from "vitest";

import {
  classifyProviderError,
  ProviderCallFailed,
  RateLimitError,
  retryAfterSeconds,
} from "../src/transports/index.js";

describe("provider error taxonomy", () => {
  it.each([
    [new RateLimitError("rate"), "quota_exhausted"],
    [Object.assign(new Error("x"), { statusCode: 429 }), "quota_exhausted"],
    [Object.assign(new Error("x"), { status: 429 }), "quota_exhausted"],
    [Object.assign(new Error("x"), { code: "quota_exceeded" }), "quota_exhausted"],
    [Object.assign(new Error("429 rate limit exceeded"), { status: "429" }), null],
    [Object.assign(new Error("x"), { code: 429 }), null],
    [new ProviderCallFailed("x", { statusCode: 500 }), null],
  ])("classifies structurally", (error, expected) => {
    expect(classifyProviderError(error)).toBe(expected);
  });

  it("prefers a direct retry hint over a case-insensitive header", () => {
    expect(
      retryAfterSeconds({
        retryAfter: "2.5",
        response: { headers: new Headers({ "Retry-After": "11" }) },
      }),
    ).toBe(2.5);
    expect(retryAfterSeconds({ response: { headers: { "retry-after": "11" } } })).toBe(11);
  });

  it.each([0, -1, true, "tomorrow", "Wed, 21 Oct 2015 07:28:00 GMT", null])(
    "rejects invalid retry hints",
    (value) => {
      expect(retryAfterSeconds({ retryAfter: value })).toBeNull();
    },
  );
});
