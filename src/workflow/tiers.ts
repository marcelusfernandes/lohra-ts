import { readFileSync, writeFileSync } from "node:fs";

export const MODEL_TIERS = ["small", "medium", "big"] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];
export interface Tier {
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
}
export type TierMap = Readonly<Partial<Record<ModelTierName, Tier>>>;

/** The operator tier map, read from the operator home per launch (#234). */
export const OPERATOR_TIERS_FILE = "workflow_tiers.json";
const TIER_FIELDS: readonly string[] = ["model", "provider", "effort"];

/** Named, fail-closed error for a `workflow_tiers.json` that exists but
 * cannot be trusted — cites the path and, in `cause`, why (#234). */
export class TiersError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super(`workflow_tiers.json at ${path} is invalid: ${reason}`, { cause });
    this.name = "TiersError";
    this.path = path;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Fail-closed sibling of `loadTiers`: distinguishes an absent file (legitimate,
 * `{}`) from one that exists but cannot be trusted — bad JSON, a non-object
 * root, or a known tier (`small`/`medium`/`big`) with an unrecognized field or
 * a wrong-typed value. An unrelated top-level key is tolerated; only the
 * known tier keys are validated strictly.
 */
export function readTiers(path: string): TierMap | TiersError {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return isEnoent(error) ? {} : new TiersError(path, "could not be read", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return new TiersError(path, "is not valid JSON", error);
  }
  const root = object(parsed);
  if (root === null) return new TiersError(path, `root must be an object, got ${typeName(parsed)}`);
  const result: Partial<Record<ModelTierName, Tier>> = {};
  for (const name of MODEL_TIERS) {
    if (!(name in root)) continue;
    const authored = root[name];
    if (typeof authored === "string") {
      const model = text(authored);
      if (model === undefined) return new TiersError(path, `tier '${name}' is an empty string`);
      result[name] = { model };
      continue;
    }
    const raw = object(authored);
    if (raw === null) {
      return new TiersError(
        path,
        `tier '${name}' must be a string or object, got ${typeName(authored)}`,
      );
    }
    const tier: Record<string, string> = {};
    for (const key of Object.keys(raw)) {
      if (!TIER_FIELDS.includes(key)) {
        return new TiersError(path, `tier '${name}' has an unknown field '${key}'`);
      }
      const value = text(raw[key]);
      if (value === undefined) {
        return new TiersError(path, `tier '${name}.${key}' must be a non-empty string`);
      }
      tier[key] = value;
    }
    if (Object.keys(tier).length === 0) {
      return new TiersError(path, `tier '${name}' has no usable field`);
    }
    result[name] = tier;
  }
  return result;
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
