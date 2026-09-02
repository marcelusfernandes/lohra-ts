#!/usr/bin/env node
import { Buffer } from "node:buffer";
import process from "node:process";
import { fetchModels, MAX_RESPONSE_BYTES } from "../../../dist/catalog/index.js";
import { applyEnvFile } from "../../../dist/config/env-file.js";
import {
  estimateCost,
  combineUsage,
  loadPriceOverrides,
  priceKey,
  usage,
} from "../../../dist/pricing/index.js";
import {
  getProviderProfile,
  listProviders,
  resolveProviderName,
} from "../../../dist/providers/index.js";
import { pythonFloat, pythonJsonDumps } from "../../../dist/serialization/python-json.js";
import { loadTiers } from "../../../dist/workflow/tiers.js";

const emit = (value) => process.stdout.write(`${pythonJsonDumps(value)}\n`);
function registryResolution() {
  const profiles = listProviders().map((p) => ({
    name: p.name,
    apiMode: p.apiMode,
    aliases: p.aliases,
    envVars: p.envVars,
    baseUrl: p.baseUrl,
    fallbackModels: p.fallbackModels,
    maxTokens: p.defaultMaxTokens,
    aux: p.defaultAuxModel,
    vision: p.supportsVision,
    requiresKey: p.requiresApiKey,
  }));
  const matrix = {
    arg: resolveProviderName(" google ", "or", { LOHRA_PROVIDER: "oai", ANTHROPIC_API_KEY: "x" }),
    config: resolveProviderName(" ", "or", { LOHRA_PROVIDER: "oai", ANTHROPIC_API_KEY: "x" }),
    env: resolveProviderName(null, null, { LOHRA_PROVIDER: "oai", ANTHROPIC_API_KEY: "x" }),
    key: resolveProviderName(null, null, { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x" }),
    spaceKey: resolveProviderName(null, null, { ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "x" }),
    auto: resolveProviderName(null, null, {}),
  };
  emit({ profiles, matrix });
}
function dotenvProfile() {
  const path = `${process.env.LOHRA_HOME}/.env`;
  const env = { OPENAI_API_KEY: "REAL_SENTINEL" };
  const applied = applyEnvFile(path, env);
  emit({
    applied,
    openai: env.OPENAI_API_KEY === "REAL_SENTINEL" ? "real" : "file",
    groq: env.GROQ_API_KEY ? "present" : "missing",
    pathScope: "base",
  });
}
const allowedHeaders = new Set([
  "accept-encoding",
  "authorization",
  "x-api-key",
  "anthropic-version",
]);
const captureRequest = (url, options) => {
  const names = Object.keys(options.headers).map((key) => key.toLowerCase());
  const unclassified = names.filter((name) => !allowedHeaders.has(name)).sort();
  if (unclassified.length > 0) throw new Error("REQUEST_HEADER_UNCLASSIFIED");
  return {
    method: "GET",
    url,
    identity: options.headers["Accept-Encoding"],
    auth: names
      .filter((name) => ["authorization", "x-api-key", "anthropic-version"].includes(name))
      .sort(),
    unclassified,
  };
};
const response = (status, payload, request) => ({
  get: async (url, options) => {
    request.value = captureRequest(url, options);
    return { status, body: Buffer.from(payload) };
  },
});
class FixtureTimeoutError extends Error {
  name = "TimeoutError";
}
const throwing = (request) => ({
  get: async (url, options) => {
    request.value = captureRequest(url, options);
    throw new FixtureTimeoutError("fixture timeout");
  },
});
async function catalogFixtures() {
  const cases = [];
  const exactCapPayload = Buffer.concat([
    Buffer.from('{"data":[]}'),
    Buffer.alloc(MAX_RESPONSE_BYTES - Buffer.byteLength('{"data":[]}'), 0x20),
  ]);
  const fixtures = [
    ["data", "openai", 200, '{"data":[{"id":"b"},{"name":"a"}]}'],
    ["bare", "openai", 200, '["bare-a",{"id":"bare-b"}]'],
    ["duplicate", "openai", 200, '{"data":[{"id":"b"},{"id":"b"},{"name":"a"}]}'],
    ["empty", "openai", 200, '{"data":[]}'],
    ["has-more", "openai", 200, '{"data":[{"id":"page-a"}],"has_more":true}'],
    ["shape", "openai", 200, "{}"],
    ["invalid", "openai", 200, "{"],
    ["http", "openai", 401, "secret-body-not-projected"],
    ["at-cap", "openai", 200, exactCapPayload],
    ["oversized", "openai", 200, Buffer.concat([exactCapPayload, Buffer.from(" ")])],
    ["headers-anthropic", "anthropic", 200, '{"data":[]}'],
    ["headers-gemini", "gemini", 200, '{"data":[]}'],
    ["headers-empty", "openai", 200, '{"data":[]}', ""],
  ];
  for (const [name, provider, status, payload, key = "SENTINEL"] of fixtures) {
    const request = {};
    const profile = getProviderProfile(provider);
    const entry = await fetchModels(profile, key, response(status, payload, request));
    cases.push({ name, entry: entry.toJSON(), request: request.value });
  }
  const request = {};
  const entry = await fetchModels(getProviderProfile("openai"), "SENTINEL", throwing(request));
  cases.splice(7, 0, { name: "exception", entry: entry.toJSON(), request: request.value });
  emit(cases);
}
function pricing(mutant = false) {
  const value = usage(
    mutant
      ? {
          inputTokens: 1700,
          outputTokens: 137,
          cacheReadTokens: 500,
          cacheWriteTokens: 200,
          reasoningTokens: 37,
        }
      : {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 500,
          cacheWriteTokens: 200,
          reasoningTokens: 37,
        },
  );
  const openai = estimateCost(value, { provider: "openai", model: "gpt-4o-mini" });
  const anthropic = estimateCost(value, { provider: "anthropic", model: "claude-haiku-4-5" });
  const local = estimateCost(value, { provider: "ollama", model: "m" });
  const override = estimateCost(usage({ inputTokens: 1_000_000 }), {
    provider: "openai",
    model: "gpt-4o-mini",
    overrides: new Map([
      [
        priceKey("openai", "gpt-4o-mini"),
        { inputPerMillion: 3, outputPerMillion: 4, source: "pricing.json" },
      ],
    ]),
  });
  emit({
    combined: (() => {
      const combined = combineUsage(usage({ inputTokens: 1 }), usage({ outputTokens: 2 }));
      return {
        input_tokens: combined.inputTokens,
        output_tokens: combined.outputTokens,
        cache_read_tokens: combined.cacheReadTokens,
        cache_write_tokens: combined.cacheWriteTokens,
        reasoning_tokens: combined.reasoningTokens,
      };
    })(),
    openai: {
      usd: pythonFloat(openai.usd),
      gross: pythonFloat(openai.grossUsd),
      saved: pythonFloat(openai.savedUsd),
      basis: openai.basis,
    },
    anthropic: { usd: pythonFloat(anthropic.usd), gross: pythonFloat(anthropic.grossUsd) },
    ollama: { usd: pythonFloat(local.usd), gross: pythonFloat(local.grossUsd), basis: local.basis },
    openrouter: null,
    override: { usd: pythonFloat(override.usd), source: override.source },
  });
}
function profileIsolation() {
  const base = process.env.LOHRA_HOME;
  const out = {};
  for (const [name, path] of [
    ["default", base],
    ["p1", `${base}/profiles/p1`],
    ["p2", `${base}/profiles/p2`],
  ]) {
    const tiers = loadTiers(`${path}/workflow_tiers.json`);
    const prices = loadPriceOverrides(`${path}/pricing.json`);
    const estimate = estimateCost(usage({ inputTokens: 1_000_000 }), {
      provider: "openai",
      model: tiers.small?.model ?? "missing",
      overrides: prices,
    });
    out[name] = {
      small: tiers.small?.model ?? null,
      priceKeys: [...prices.keys()].map((key) => key.replace("\0", "/")).sort(),
      cost: estimate === null ? null : pythonFloat(estimate.usd),
      source: estimate?.source ?? null,
    };
  }
  emit(out);
}
const mode = process.argv[2];
if (mode === "registry-resolution") registryResolution();
else if (mode === "dotenv-profile") dotenvProfile();
else if (mode === "catalog-fixtures") await catalogFixtures();
else if (mode === "pricing-usage") pricing();
else if (mode === "profile-isolation") profileIsolation();
else if (mode === "pricing-mutant") pricing(true);
else throw new Error(`unknown mode ${mode}`);
