import { describe, expect, it } from "vitest";

import { clampFlagMinOne, positiveIntEnv } from "../src/orchestration/limits.js";

describe("positiveIntEnv", () => {
  it("returns the default silently when the variable is unset or empty", () => {
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", undefined, 4)).toEqual({
      value: 4,
      warning: null,
    });
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "", 4)).toEqual({
      value: 4,
      warning: null,
    });
  });

  it("returns the raw integer value when valid and >= 1", () => {
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "2", 4)).toEqual({
      value: 2,
      warning: null,
    });
  });

  it("falls back with a 'not an integer' warning for non-integer strings, matching Python int() semantics", () => {
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "abc", 4)).toEqual({
      value: 4,
      warning: "ignoring LOHRA_MAX_PARALLEL='abc': not an integer; using 4",
    });
    // "3.0" is a number but not a Python int() literal — same branch as "abc".
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "3.0", 4)).toEqual({
      value: 4,
      warning: "ignoring LOHRA_MAX_PARALLEL='3.0': not an integer; using 4",
    });
  });

  it("falls back with a 'must be >= 1' warning for valid integers below the floor", () => {
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "0", 4)).toEqual({
      value: 4,
      warning: "ignoring LOHRA_MAX_PARALLEL='0': must be >= 1; using 4",
    });
    expect(positiveIntEnv("LOHRA_MAX_SUBSESSIONS", "-3", 200)).toEqual({
      value: 200,
      warning: "ignoring LOHRA_MAX_SUBSESSIONS='-3': must be >= 1; using 200",
    });
  });

  it("cites the per-variable default in the warning, not a shared constant", () => {
    expect(positiveIntEnv("LOHRA_MAX_ITERATIONS", "abc", 90)).toEqual({
      value: 90,
      warning: "ignoring LOHRA_MAX_ITERATIONS='abc': not an integer; using 90",
    });
    expect(positiveIntEnv("LOHRA_MAX_ITERATIONS", "0", 90)).toEqual({
      value: 90,
      warning: "ignoring LOHRA_MAX_ITERATIONS='0': must be >= 1; using 90",
    });
  });

  it("matches the errata E1 template for any untested raw value (falsifies a closed-list matcher)", () => {
    // The contract's own errata: a closed list of examples is falsifiable by
    // any untested raw value. 'xyz' was never in any example list.
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "xyz", 4)).toEqual({
      value: 4,
      warning: "ignoring LOHRA_MAX_PARALLEL='xyz': not an integer; using 4",
    });
  });

  it("accepts whitespace-padded and explicitly signed integers, mirroring Python's int()", () => {
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", " 2 ", 4)).toEqual({
      value: 2,
      warning: null,
    });
    expect(positiveIntEnv("LOHRA_MAX_PARALLEL", "+2", 4)).toEqual({
      value: 2,
      warning: null,
    });
  });
});

describe("clampFlagMinOne", () => {
  it("passes through positive integers unchanged", () => {
    expect(clampFlagMinOne(1)).toBe(1);
    expect(clampFlagMinOne(3)).toBe(3);
  });

  it("clamps zero and negative values to 1 — the asymmetric flag rule (assertion 24)", () => {
    expect(clampFlagMinOne(0)).toBe(1);
    expect(clampFlagMinOne(-5)).toBe(1);
  });

  it("truncates non-integer numbers before clamping", () => {
    expect(clampFlagMinOne(2.9)).toBe(2);
    expect(clampFlagMinOne(-0.5)).toBe(1);
  });
});
