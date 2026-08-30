import type { CostEstimate, ModelPrice, Usage } from "./types.js";

export const PRICE_SNAPSHOT_DATE = "2026-08-28";
const source = `snapshot ${PRICE_SNAPSHOT_DATE}`;
const prices = new Map<string, ModelPrice>([
  [
    "openai\0gpt-4o-mini",
    {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.075,
      source,
      note: "no cache write price — billed as input",
    },
  ],
  [
    "anthropic\0claude-haiku-4-5",
    {
      inputPerMillion: 1,
      outputPerMillion: 5,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
      source,
    },
  ],
]);
export type PriceTable = ReadonlyMap<string, ModelPrice>;
export function priceKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}
function lookup(table: PriceTable, provider: string, model: string): ModelPrice | undefined {
  const exact = table.get(priceKey(provider, model));
  if (exact) return exact;
  let found: readonly [string, ModelPrice] | undefined;
  for (const [key, value] of table) {
    const [p, m] = key.split("\0") as [string, string];
    if (p !== provider || !model.startsWith(m)) continue;
    const rest = model.slice(m.length);
    if (rest && !["-", ".", ":", "/", "@"].includes(rest[0] ?? "")) continue;
    if (found === undefined || m.length > found[0].length) found = [m, value];
  }
  return found?.[1];
}
export function estimateCost(
  value: Usage | null,
  options: {
    readonly provider: string;
    readonly model: string;
    readonly table?: PriceTable;
    readonly overrides?: PriceTable;
    readonly equivalents?: ReadonlyMap<string, readonly [string, string]>;
  },
): CostEstimate | null {
  if (value === null) return null;
  let provider = options.provider,
    model = options.model,
    basis: CostEstimate["basis"] =
      provider === "openai-codex" || options.equivalents?.has(priceKey(provider, model)) === true
        ? "api_equivalent"
        : "api_list_price";
  const direct = lookup(options.overrides ?? new Map(), provider, model);
  if (direct) return calculate(value, direct, basis);
  if (provider === "ollama") return { usd: 0, grossUsd: 0, savedUsd: 0, basis: "local" };
  if (provider === "openrouter") return null;
  const mapped = options.equivalents?.get(priceKey(provider, model));
  if (mapped) {
    [provider, model] = mapped;
    basis = "api_equivalent";
  }
  const price =
    lookup(options.overrides ?? new Map(), provider, model) ??
    lookup(options.table ?? prices, provider, model);
  return price ? calculate(value, price, basis) : null;
}
function calculate(value: Usage, price: ModelPrice, basis: CostEstimate["basis"]): CostEstimate {
  const input = price.inputPerMillion,
    output = price.outputPerMillion;
  const real =
    (value.inputTokens * input +
      value.cacheReadTokens * (price.cacheReadPerMillion ?? input) +
      value.cacheWriteTokens * (price.cacheWritePerMillion ?? input) +
      value.outputTokens * output +
      value.reasoningTokens * (price.reasoningPerMillion ?? 0)) /
    1_000_000;
  const gross =
    ((value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens) * input +
      value.outputTokens * output +
      value.reasoningTokens * (price.reasoningPerMillion ?? 0)) /
    1_000_000;
  const result: {
    usd: number;
    grossUsd: number;
    savedUsd: number;
    basis: CostEstimate["basis"];
    source?: string;
    note?: string;
  } = { usd: real, grossUsd: gross, savedUsd: Math.max(gross - real, 0), basis };
  if (price.source) result.source = price.source;
  if (price.note) result.note = price.note;
  return result;
}
