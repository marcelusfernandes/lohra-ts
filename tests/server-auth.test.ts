import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { authorized, timingSafeStringEqual } from "../src/server/auth.js";

const API_KEY = "super-secret-key";

describe("authorized — Bearer parsing against the measured auth matrix", () => {
  it("insecure mode (apiKey null) accepts anything, including garbage schemes", () => {
    expect(authorized(undefined, null)).toBe(true);
    expect(authorized("Basic zzz", null)).toBe(true);
    expect(authorized("", null)).toBe(true);
  });

  it("rejects a missing/empty Authorization header", () => {
    expect(authorized(undefined, API_KEY)).toBe(false);
    expect(authorized("", API_KEY)).toBe(false);
  });

  it("rejects a wrong key", () => {
    expect(authorized("Bearer wrong-key", API_KEY)).toBe(false);
  });

  it("is case-sensitive on the Bearer scheme (lowercase bearer rejected)", () => {
    expect(authorized(`bearer ${API_KEY}`, API_KEY)).toBe(false);
  });

  it("rejects Basic and a raw token with no scheme", () => {
    expect(authorized(`Basic ${API_KEY}`, API_KEY)).toBe(false);
    expect(authorized(API_KEY, API_KEY)).toBe(false);
  });

  it("accepts the correct key and trims trailing whitespace after it", () => {
    expect(authorized(`Bearer ${API_KEY}`, API_KEY)).toBe(true);
    expect(authorized(`Bearer ${API_KEY}  `, API_KEY)).toBe(true);
  });
});

describe("timingSafeStringEqual", () => {
  it("compares equal and unequal strings, including different lengths, without throwing", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
    expect(timingSafeStringEqual("a".repeat(500), "b".repeat(3))).toBe(false);
  });
});

describe("[probe-complementar] timing-safe primitive is actually wired, not ===", () => {
  it("the auth module source calls node:crypto's constant-time compare", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/server/auth.ts", import.meta.url)), "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).toMatch(/from ["']node:crypto["']/u);
  });
});
