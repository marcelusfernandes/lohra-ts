import { readFileSync, writeFileSync } from "node:fs";

export const MODEL_TIERS = ["small", "medium", "big"] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];
export interface Tier {
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
}
export type TierMap = Readonly<Partial<Record<ModelTierName, Tier>>>;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function loadTiers(path: string): TierMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
  const root = object(parsed);
  if (root === null) return {};
  const result: Partial<Record<ModelTierName, Tier>> = {};
  for (const name of MODEL_TIERS) {
    const authored = root[name];
    if (typeof authored === "string") {
      const model = text(authored);
      if (model !== undefined) result[name] = { model };
      continue;
    }
    const raw = object(authored);
    if (raw === null) continue;
    const tier: Record<string, string> = {};
    for (const key of ["model", "provider", "effort"] as const) {
      const value = text(raw[key]);
      if (value !== undefined) tier[key] = value;
    }
    if (Object.keys(tier).length > 0) result[name] = tier;
  }
  return result;
}
export function writeTiers(path: string, tiers: TierMap): void {
  writeFileSync(path, `${JSON.stringify(tiers, null, 2)}\n`, "utf8");
}
