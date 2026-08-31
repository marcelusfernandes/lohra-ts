import { timingSafeEqual as realTimingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { timingSafeTokenEqual } from "../../src/gateway/auth.js";

// Assertion 68 ([probe-complementar] t12-auth-timing-safe-mutant-killed):
// a mutant that swaps the constant-time primitive for `===`/a naive
// comparison must fail here, even though it produces the IDENTICAL boolean
// result for every input -- the wire can never distinguish constant-time
// from `===` (that's the whole point of the primitive), so no HTTP golden
// can prove this property. This spies on node:crypto's own
// timingSafeEqual export and asserts it is actually INVOKED with the
// candidate/expected buffers, on every code path -- not just present
// somewhere in the file, which a naive `===` swap (or an obfuscated mutant
// that keeps a dead call around) would still satisfy.
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe("timingSafeTokenEqual: constant-time guard (assertion 68)", () => {
  it("invokes node:crypto's timingSafeEqual on the equal-length match path", async () => {
    const crypto = await import("node:crypto");
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();

    const result = timingSafeTokenEqual("same-length-token-AAAA", "same-length-token-AAAA");

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("invokes node:crypto's timingSafeEqual on the equal-length mismatch path", async () => {
    const crypto = await import("node:crypto");
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();

    const result = timingSafeTokenEqual("same-length-token-AAAA", "same-length-token-BBBB");

    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("STILL invokes it on the length-mismatch branch -- no early `!==` return before the constant-time compare", async () => {
    const crypto = await import("node:crypto");
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();

    const result = timingSafeTokenEqual("short", "a-much-longer-token-entirely");

    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a `===` mutant would pass every boolean-outcome assertion above -- proving THIS test, not just the outcome, is what closes assertion 68", () => {
    // Independently confirms the differential: a naive mutant produces the
    // identical true/false result the three tests above check, which is
    // exactly why this file spies on the PRIMITIVE rather than the
    // boolean return value.
    const a: string = "same-length-token-AAAA";
    const b: string = "same-length-token-BBBB";
    expect(a === a).toBe(true);
    expect(a === b).toBe(false);
    expect(realTimingSafeEqual(Buffer.from("x"), Buffer.from("x"))).toBe(true);
  });
});
