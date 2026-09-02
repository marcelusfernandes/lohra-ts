import { describe, expect, it } from "vitest";

import { resolveFanout } from "../src/orchestration/fanout-config.js";

const noEnv: Readonly<Record<string, string | undefined>> = {};

describe("resolveFanout — contract assertion 24 (13-row asymmetric clamp table)", () => {
  it("defaults to maxParallel=4, maxSubsessions=200, parentMaxIterations=90 with nothing configured", () => {
    const result = resolveFanout(undefined, undefined, noEnv);
    expect(result.maxParallel).toBe(4);
    expect(result.maxSubsessions).toBe(200);
    expect(result.parentMaxIterations).toBe(90);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["--max-parallel 1", "1", 1],
    ["--max-parallel 2", "2", 2],
    ["--max-parallel 3", "3", 3],
  ])("%s -> %s", (_label, flag, expected) => {
    expect(resolveFanout(flag, undefined, noEnv).maxParallel).toBe(expected);
  });

  it.each([
    ["--max-parallel 0", "0"],
    ["--max-parallel -5", "-5"],
  ])("%s clamps to 1 (flag never falls back)", (_label, flag) => {
    const result = resolveFanout(flag, undefined, noEnv);
    expect(result.maxParallel).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["0", "must be >= 1"],
    ["-5", "must be >= 1"],
    ["abc", "not an integer"],
    ["3.0", "not an integer"],
  ])("LOHRA_MAX_PARALLEL=%s falls back to 4 (env never clamps to 1)", (raw, reason) => {
    const result = resolveFanout(undefined, undefined, { LOHRA_MAX_PARALLEL: raw });
    expect(result.maxParallel).toBe(4);
    expect(result.warnings).toEqual([`ignoring LOHRA_MAX_PARALLEL='${raw}': ${reason}; using 4`]);
  });

  it("LOHRA_MAX_PARALLEL='' falls back to 4 silently — no warning line at all", () => {
    const result = resolveFanout(undefined, undefined, { LOHRA_MAX_PARALLEL: "" });
    expect(result.maxParallel).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it("LOHRA_MAX_PARALLEL=2 (valid) is used with no warning", () => {
    const result = resolveFanout(undefined, undefined, { LOHRA_MAX_PARALLEL: "2" });
    expect(result.maxParallel).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("flag beats env in both directions (assertion 26)", () => {
    expect(resolveFanout("3", undefined, { LOHRA_MAX_PARALLEL: "1" }).maxParallel).toBe(3);
    expect(resolveFanout("1", undefined, { LOHRA_MAX_PARALLEL: "5" }).maxParallel).toBe(1);
  });

  it("throws CHAT_OPTION_INVALID:max-parallel for a non-integer flag value — mirrors finite()'s existing convention, not a byte-exact oracle claim (unmeasured)", () => {
    expect(() => resolveFanout("abc", undefined, noEnv)).toThrow(
      "CHAT_OPTION_INVALID:max-parallel",
    );
    expect(() => resolveFanout("3.0", undefined, noEnv)).toThrow(
      "CHAT_OPTION_INVALID:max-parallel",
    );
  });

  it("LOHRA_MAX_SUBSESSIONS is env-only (assertion 27) and follows the same fallback rule", () => {
    const invalid = resolveFanout(undefined, undefined, { LOHRA_MAX_SUBSESSIONS: "abc" });
    expect(invalid.maxSubsessions).toBe(200);
    expect(invalid.warnings).toEqual([
      "ignoring LOHRA_MAX_SUBSESSIONS='abc': not an integer; using 200",
    ]);

    const valid = resolveFanout(undefined, undefined, { LOHRA_MAX_SUBSESSIONS: "5" });
    expect(valid.maxSubsessions).toBe(5);
    expect(valid.warnings).toEqual([]);
  });

  it("the flag beats LOHRA_MAX_ITERATIONS for the parent's own leash", () => {
    const result = resolveFanout(undefined, 5, { LOHRA_MAX_ITERATIONS: "20" });
    expect(result.parentMaxIterations).toBe(5);
    expect(result.warnings).toEqual([]);
  });

  it("LOHRA_MAX_ITERATIONS falls back to 90 on an invalid value, with the byte-exact template warning", () => {
    const result = resolveFanout(undefined, undefined, { LOHRA_MAX_ITERATIONS: "abc" });
    expect(result.parentMaxIterations).toBe(90);
    expect(result.warnings).toEqual([
      "ignoring LOHRA_MAX_ITERATIONS='abc': not an integer; using 90",
    ]);
  });

  it("collects warnings from independently-invalid env vars in a stable, declared order", () => {
    const result = resolveFanout(undefined, undefined, {
      LOHRA_MAX_PARALLEL: "abc",
      LOHRA_MAX_SUBSESSIONS: "abc",
      LOHRA_MAX_ITERATIONS: "abc",
    });
    expect(result.warnings).toEqual([
      "ignoring LOHRA_MAX_PARALLEL='abc': not an integer; using 4",
      "ignoring LOHRA_MAX_SUBSESSIONS='abc': not an integer; using 200",
      "ignoring LOHRA_MAX_ITERATIONS='abc': not an integer; using 90",
    ]);
  });
});
