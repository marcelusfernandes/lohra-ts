import { readFileSync } from "node:fs";
import { priceKey, type PriceTable } from "./estimate.js";
import type { ModelPrice } from "./types.js";
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
const priceFields = new Set([
  "input_usd",
  "output_usd",
  "cached_input_usd",
  "cache_write_usd",
  "reasoning_usd",
]);
export function loadPriceOverrides(path: string): PriceTable {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error("PRICING_JSON_INVALID", { cause: error });
  }
  const root = object(raw);
  if (root === null) throw new Error("PRICING_SCHEMA_INVALID");
  const output = new Map<string, ModelPrice>();
  for (const [provider, models] of Object.entries(root)) {
    const modelMap = object(models);
    if (!provider || modelMap === null) throw new Error("PRICING_SCHEMA_INVALID");
    for (const [model, entry] of Object.entries(modelMap)) {
      const source = object(entry);
      const input = source === null ? null : rate(source.input_usd);
      const outputRate = source === null ? null : rate(source.output_usd);
      if (
        !model ||
        source === null ||
        input === null ||
        outputRate === null ||
        Object.keys(source).some((name) => !priceFields.has(name)) ||
        (source.cached_input_usd !== undefined && rate(source.cached_input_usd) === null) ||
        (source.cache_write_usd !== undefined && rate(source.cache_write_usd) === null) ||
        (source.reasoning_usd !== undefined && rate(source.reasoning_usd) === null)
      )
        throw new Error("PRICING_SCHEMA_INVALID");
      const price: ModelPrice = {
        inputPerMillion: input,
        outputPerMillion: outputRate,
        source: "pricing.json",
        ...(source.cached_input_usd !== undefined
          ? { cacheReadPerMillion: rate(source.cached_input_usd) as number }
          : {}),
        ...(source.cache_write_usd !== undefined
          ? { cacheWritePerMillion: rate(source.cache_write_usd) as number }
          : {}),
        ...(source.reasoning_usd !== undefined
          ? { reasoningPerMillion: rate(source.reasoning_usd) as number }
          : {}),
      };
      output.set(priceKey(provider, model), price);
    }
  }
  return output;
}
