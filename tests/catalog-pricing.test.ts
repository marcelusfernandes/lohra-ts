import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authHeaders,
  buildCatalog,
  fetchModels,
  MAX_CONCURRENT_FETCHES,
  MAX_RESPONSE_BYTES,
  type CatalogHttpClient,
} from "../src/catalog/catalog.js";
import { extractModels } from "../src/catalog/windows.js";
import {
  loadWindowsCache,
  saveWindowsCache,
  MAX_CACHE_BYTES,
  MAX_MODELS_PER_PROVIDER,
  type WindowsCache,
} from "../src/catalog/windows-cache.js";
import { getProviderProfile } from "../src/providers/registry.js";
import { estimateCost, priceKey } from "../src/pricing/estimate.js";
import { loadPriceOverrides } from "../src/pricing/overrides.js";
import { combineUsage, usage } from "../src/pricing/usage.js";
import { jsonFloat, stringifyJsonPreservingNumbers } from "../src/serialization/json-numbers.js";

// Recorte real de `GET https://openrouter.ai/api/v1/models` (2026-09),
// reduzido a dois modelos e aos campos que o extrator lê ou ignora de
// propósito — `context_length` é a janela; `pricing`/`architecture` ficam
// só para provar que o extrator não se distrai com o resto do payload.
const OPENROUTER_MODELS_FIXTURE = {
  data: [
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Anthropic: Claude 3.5 Sonnet",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      top_provider: { context_length: 200000, max_completion_tokens: 8192 },
    },
    {
      id: "openai/gpt-4o-mini",
      name: "OpenAI: GPT-4o mini",
      context_length: 128000,
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
  ],
};

// Recorte real de `GET https://api.openai.com/v1/models` — a OpenAI não
// expõe janela nenhuma nessa lista; o único jeito de saber é a
// documentação, fora deste payload.
const OPENAI_MODELS_FIXTURE = {
  object: "list",
  data: [
    { id: "gpt-4o-mini", object: "model", created: 1721172741, owned_by: "system" },
    { id: "gpt-4o", object: "model", created: 1715367049, owned_by: "system" },
  ],
};

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
describe("model context windows (extraction, issue #249)", () => {
  it("reads context_length off an OpenRouter-shaped payload", () => {
    expect(extractModels(OPENROUTER_MODELS_FIXTURE)).toEqual({
      ids: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"],
      windows: {
        "anthropic/claude-3.5-sonnet": 200000,
        "openai/gpt-4o-mini": 128000,
      },
    });
  });
  it("is null, never invented, for a provider whose payload has no window field", () => {
    expect(extractModels(OPENAI_MODELS_FIXTURE)).toEqual({
      ids: ["gpt-4o-mini", "gpt-4o"],
      windows: { "gpt-4o-mini": null, "gpt-4o": null },
    });
  });
  it("falls back from context_length to max_input_tokens to context_window, in that order", () => {
    expect(
      extractModels({
        data: [
          { id: "a", context_length: 1000 },
          { id: "b", max_input_tokens: 2000 },
          { id: "c", context_window: 3000 },
          { id: "b2", max_input_tokens: 2000, context_window: 9999 },
        ],
      }),
    ).toEqual({
      ids: ["a", "b", "c", "b2"],
      windows: { a: 1000, b: 2000, c: 3000, b2: 2000 },
    });
  });
  it("never invents a window from a non-positive, non-integer or non-numeric field", () => {
    expect(
      extractModels({
        data: [
          { id: "zero", context_length: 0 },
          { id: "negative", context_length: -5 },
          { id: "float", context_length: 12.5 },
          { id: "string", context_length: "128000" },
          { id: "infinite", context_length: Infinity },
          { id: "nan", context_length: Number.NaN },
        ],
      }),
    ).toEqual({
      ids: ["zero", "negative", "float", "string", "infinite", "nan"],
      windows: {
        zero: null,
        negative: null,
        float: null,
        string: null,
        infinite: null,
        nan: null,
      },
    });
  });
  it("dedups by id keeping the first occurrence's window, matching modelIds", () => {
    expect(
      extractModels({
        data: [
          { id: "dup", context_length: 111 },
          { id: "dup", context_length: 222 },
        ],
      }),
    ).toEqual({ ids: ["dup"], windows: { dup: 111 } });
  });
  it("is null for a string-only id (no metadata to read a window from)", () => {
    expect(extractModels(["plain-id"])).toEqual({
      ids: ["plain-id"],
      windows: { "plain-id": null },
    });
  });
  it("returns null for an unrecognized payload shape, same as modelIds", () => {
    expect(extractModels({})).toBeNull();
    expect(extractModels(null)).toBeNull();
  });
});
describe("model context window cache (issue #249)", () => {
  const roots: string[] = [];
  const cachePath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lohra-t249-windows-cache-"));
    roots.push(dir);
    return join(dir, "model_windows.json");
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads {} silently when the cache file does not exist yet", () => {
    expect(loadWindowsCache(cachePath())).toEqual({ data: {}, warning: null });
  });

  it("round-trips windows through save then load, surviving a fresh instance", () => {
    const path = cachePath();
    const fresh: WindowsCache = { openrouter: { "a/b": 128000, "c/d": null } };
    expect(saveWindowsCache(path, {}, fresh)).toBeNull();
    expect(loadWindowsCache(path)).toEqual({ data: fresh, warning: null });
  });

  it("merges a fresh provider into what was already cached, leaving other providers alone", () => {
    const path = cachePath();
    saveWindowsCache(path, {}, { openrouter: { m: 1000 } });
    const { data: afterFirst } = loadWindowsCache(path);
    expect(saveWindowsCache(path, afterFirst, { openai: { n: 2000 } })).toBeNull();
    expect(loadWindowsCache(path)).toEqual({
      data: { openrouter: { m: 1000 }, openai: { n: 2000 } },
      warning: null,
    });
  });

  it("refetches with a warning instead of crashing on invalid JSON", () => {
    const path = cachePath();
    writeFileSync(path, "{not json");
    const result = loadWindowsCache(path);
    expect(result.data).toEqual({});
    expect(result.warning).toMatch(/refetch|invalid|corrupt/iu);
  });

  it("refetches with a warning instead of crashing on a malformed shape", () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ openrouter: { m: "not-a-number-or-null" } }));
    const result = loadWindowsCache(path);
    expect(result.data).toEqual({});
    expect(result.warning).not.toBeNull();
  });

  it("refetches with a warning instead of crashing on an oversized file", () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ openrouter: { m: 1 } }) + " ".repeat(MAX_CACHE_BYTES + 1));
    const result = loadWindowsCache(path);
    expect(result.data).toEqual({});
    expect(result.warning).not.toBeNull();
  });

  it("caps a provider at MAX_MODELS_PER_PROVIDER entries when saving", () => {
    const path = cachePath();
    const many: Record<string, number | null> = {};
    for (let i = 0; i < MAX_MODELS_PER_PROVIDER + 10; i++) many[`m${String(i)}`] = i;
    expect(saveWindowsCache(path, {}, { openrouter: many })).toBeNull();
    const { data } = loadWindowsCache(path);
    expect(Object.keys(data.openrouter ?? {})).toHaveLength(MAX_MODELS_PER_PROVIDER);
  });

  it("warns and skips the write instead of crashing when a capped provider still exceeds the byte cap", () => {
    const path = cachePath();
    const huge: Record<string, number | null> = {};
    const longId = "m".repeat(5000);
    for (let i = 0; i < MAX_MODELS_PER_PROVIDER + 50; i++) huge[`${longId}-${String(i)}`] = i;
    const warning = saveWindowsCache(path, {}, { openrouter: huge });
    expect(warning).not.toBeNull();
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
    expect(stringifyJsonPreservingNumbers({ saved: jsonFloat(openai.savedUsd) })).toBe(
      '{"saved":3.749999999999999e-05}',
    );
    const local = requiredCost(estimateCost(value, { provider: "ollama", model: "m" }));
    expect(stringifyJsonPreservingNumbers({ usd: jsonFloat(local.usd) })).toBe('{"usd":0.0}');
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
