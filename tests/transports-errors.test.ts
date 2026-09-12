import { describe, expect, it } from "vitest";

import {
  classifyProviderError,
  ProviderCallFailed,
  RateLimitError,
  retryAfterSeconds,
  withTextTracking,
} from "../src/transports/index.js";
import { anthropicPartialUsage } from "../src/transports/errors.js";

describe("provider error taxonomy", () => {
  it.each([
    [new RateLimitError("rate"), "quota_exhausted"],
    [Object.assign(new Error("x"), { statusCode: 429 }), "quota_exhausted"],
    [Object.assign(new Error("x"), { status: 429 }), "quota_exhausted"],
    [Object.assign(new Error("x"), { code: "quota_exceeded" }), "quota_exhausted"],
    [Object.assign(new Error("429 rate limit exceeded"), { status: "429" }), null],
    [Object.assign(new Error("x"), { code: 429 }), null],
    // #397 (M8-1): 5xx passou a se classificar como route_fault; o pino
    // "500 -> null" mudou de valor por emenda do orquestrador ao `## Files`
    // (2026-09-12, opção (a)) — não é o único bloqueado por este teste,
    // ver tests/orchestration-child-runner.test.ts também.
    [new ProviderCallFailed("x", { statusCode: 500 }), "route_fault"],
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
    expect(retryAfterSeconds({ response: { headers: { "Retry-After": "11" } } })).toBeNull();
  });

  it.each([0, -1, true, "tomorrow", "Wed, 21 Oct 2015 07:28:00 GMT", null])(
    "rejects invalid retry hints",
    (value) => {
      expect(retryAfterSeconds({ retryAfter: value })).toBeNull();
    },
  );
});

describe("anthropicPartialUsage (PartialStream's contract — issue #567)", () => {
  it("is null when no message_start frame ever arrived", () => {
    expect(
      anthropicPartialUsage([
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      ]),
    ).toBeNull();
  });

  it("is null, not a zeroed Usage, when message_start arrived without its own usage object", () => {
    // A zeroed `Usage` here would be indistinguishable from "no
    // message_start at all" for a caller — both would read as "0 input
    // tokens" instead of "we don't actually know".
    expect(anthropicPartialUsage([{ type: "message_start", message: {} }])).toBeNull();
  });

  it("fills real counts when message_start carries a usage object", () => {
    expect(
      anthropicPartialUsage([{ type: "message_start", message: { usage: { input_tokens: 5 } } }]),
    ).toMatchObject({ inputTokens: 5, outputTokens: 0 });
  });
});

describe("withTextTracking (public export — issue #567)", () => {
  it("recovers exactly the text forwarded through onText while still calling the original callback", () => {
    const received: string[] = [];
    const tracked = withTextTracking({ onText: (text) => received.push(text) });
    tracked.callbacks.onText?.("ola ");
    tracked.callbacks.onText?.("mundo");
    expect(tracked.text()).toBe("ola mundo");
    expect(received).toEqual(["ola ", "mundo"]);
  });
});
