import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authHeaders,
  buildCatalog,
  fetchModels,
  MAX_CONCURRENT_FETCHES,
  MAX_RESPONSE_BYTES,
  type CatalogHttpClient,
} from "../src/catalog/catalog.js";
import { getProviderProfile } from "../src/providers/registry.js";
import { estimateCost, priceKey } from "../src/pricing/estimate.js";
import { loadPriceOverrides } from "../src/pricing/overrides.js";
import { combineUsage, usage } from "../src/pricing/usage.js";
import { pythonFloat, pythonJsonDumps } from "../src/serialization/python-json.js";

const response = (payload: unknown, status = 200): CatalogHttpClient => ({
  get: () => Promise.resolve({ status, body: new TextEncoder().encode(JSON.stringify(payload)) }),
});
function profile(name: string) {
  const value = getProviderProfile(name);
  if (value === null) throw new Error(`missing test profile: ${name}`);
  return value;
}
function requiredCost<T>(value: T | null): T {
  if (value === null) throw new Error("missing test estimate");
  return value;
}
describe("catalog fixtures", () => {
  it("does no request without keys and preserves registry order", async () => {
    let calls = 0;
    const client: CatalogHttpClient = {
      get: () => {
        calls++;
        return Promise.reject(new Error("network"));
      },
    };
    const catalog = await buildCatalog({
      environment: {},
      client,
      probeOllama: () =>
        Promise.resolve({ alive: false, detail: "ConnectError", models: [], url: "u" }),
    });
    expect(catalog.entries).toHaveLength(11);
    expect(calls).toBe(0);
  });
  it("bounds concurrent live catalog fetches at eight", async () => {
    let active = 0;
    let maximum = 0;
    const client: CatalogHttpClient = {
      get: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: 200, body: new TextEncoder().encode('{"data":[]}') };
      },
    };
    const catalog = await buildCatalog({
      environment: {
        ANTHROPIC_API_KEY: "x",
        OPENAI_API_KEY: "x",
        OPENROUTER_API_KEY: "x",
        DEEPSEEK_API_KEY: "x",
        GROQ_API_KEY: "x",
        TOGETHER_API_KEY: "x",
        GEMINI_API_KEY: "x",
        XAI_API_KEY: "x",
        ZHIPUAI_API_KEY: "x",
        MOONSHOT_API_KEY: "x",
      },
      client,
      probeOllama: () =>
        Promise.resolve({ alive: false, detail: "ConnectError", models: [], url: "u" }),
    });
    expect(catalog.entries).toHaveLength(11);
    expect(maximum).toBe(MAX_CONCURRENT_FETCHES);
  });
  it("parses, deduplicates and classifies injected responses", async () => {
    const openaiProfile = profile("openai");
    const live = await fetchModels(
      openaiProfile,
      "secret",
      response({ data: [{ id: "b" }, { name: "a" }, { id: "b" }], has_more: true }),
    );
    expect(live.toJSON()).toEqual({
      provider: "openai",
      source: "live",
      total: 2,
      models: ["b", "a"],
      detail: "first page only (2 ids) — the provider has more",
    });
    expect((await fetchModels(openaiProfile, "x", response({}, 200))).detail).toBe(
      "unexpected response shape",
    );
    expect((await fetchModels(openaiProfile, "x", response({}, 401))).detail).toBe("HTTP 401");
    const tooLarge: CatalogHttpClient = {
      get: () => Promise.resolve({ status: 200, body: new Uint8Array(MAX_RESPONSE_BYTES + 1) }),
    };
    expect((await fetchModels(openaiProfile, "x", tooLarge)).detail).toContain(
      "response too large",
    );
  });
  it("derives auth headers from API mode and omits auth for an empty key", () => {
    expect(authHeaders(profile("anthropic"), "x")).toEqual({
      "x-api-key": "x",
      "anthropic-version": "2023-06-01",
      "Accept-Encoding": "identity",
    });
    expect(authHeaders(profile("gemini"), "x")).toEqual({
      Authorization: "Bearer x",
      "Accept-Encoding": "identity",
    });
    expect(authHeaders(profile("openai"), "")).toEqual({
      "Accept-Encoding": "identity",
    });
  });
});
describe("usage and pricing", () => {
  it("combines five disjoint meters immutably", () => {
    const a = usage({ inputTokens: 1, cacheReadTokens: 2, reasoningTokens: 3 });
    const b = usage({ outputTokens: 4, cacheWriteTokens: 5 });
    expect(combineUsage(a, b)).toEqual({
      inputTokens: 1,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
    });
    expect(() => usage({ inputTokens: -1 })).toThrow("USAGE_INTEGER_INVALID");
  });
  it("matches the snapshot bytes at integral and exponential float boundaries", () => {
    const value = usage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      reasoningTokens: 37,
    });
    const openai = requiredCost(estimateCost(value, { provider: "openai", model: "gpt-4o-mini" }));
    expect(openai.usd).toBe(0.0002775);
    expect(openai.grossUsd).toBe(0.000315);
    expect(pythonJsonDumps({ saved: pythonFloat(openai.savedUsd) })).toBe(
      '{"saved": 3.749999999999999e-05}',
    );
    const local = requiredCost(estimateCost(value, { provider: "ollama", model: "m" }));
    expect(pythonJsonDumps({ usd: pythonFloat(local.usd) })).toBe('{"usd": 0.0}');
    expect(estimateCost(value, { provider: "openrouter", model: "m" })).toBeNull();
  });
  it("lets overrides win local and dynamic short-circuits", () => {
    const overrides = new Map([
      [
        priceKey("ollama", "m"),
        { inputPerMillion: 1, outputPerMillion: 2, source: "pricing.json" },
      ],
    ]);
    expect(
      estimateCost(usage({ inputTokens: 1_000_000 }), { provider: "ollama", model: "m", overrides })
        ?.usd,
    ).toBe(1);
    expect(
      estimateCost(usage({ inputTokens: 1_000_000 }), {
        provider: "openrouter",
        model: "m",
        overrides: new Map([
          [priceKey("openrouter", "m"), { inputPerMillion: 2, outputPerMillion: 3 }],
        ]),
      }),
    ).toMatchObject({ usd: 2, basis: "api_list_price" });
    expect(
      estimateCost(usage({ inputTokens: 1_000_000 }), {
        provider: "openai-codex",
        model: "codex-model",
        equivalents: new Map([
          [priceKey("openai-codex", "codex-model"), ["openai", "gpt-4o-mini"] as const],
        ]),
      }),
    ).toMatchObject({ usd: 0.15, basis: "api_equivalent" });
  });
  it("never reports a negative saving when a cache-write premium dominates", () => {
    const overrides = new Map([
      [
        priceKey("custom", "m"),
        { inputPerMillion: 1, outputPerMillion: 0, cacheWritePerMillion: 2 },
      ],
    ]);
    expect(
      estimateCost(usage({ cacheWriteTokens: 1_000_000 }), {
        provider: "custom",
        model: "m",
        overrides,
      })?.savedUsd,
    ).toBe(0);
  });
  it("loads complete non-negative overrides and fails closed on one bad field", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t04-pricing-"));
    const path = join(root, "pricing.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          custom: {
            model: {
              input_usd: 1,
              output_usd: 2,
              cached_input_usd: 0.5,
              cache_write_usd: 3,
              reasoning_usd: 4,
            },
          },
        }),
      );
      expect(loadPriceOverrides(path).get(priceKey("custom", "model"))).toMatchObject({
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 3,
        reasoningPerMillion: 4,
      });
      writeFileSync(
        path,
        JSON.stringify({ custom: { good: { input_usd: 1, output_usd: 2 }, bad: {} } }),
      );
      expect(() => loadPriceOverrides(path)).toThrow("PRICING_SCHEMA_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
