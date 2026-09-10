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

const SUGGESTION_MAX_DISTANCE = 2;

/** Levenshtein edit distance, plain two-row dynamic programming. */
function editDistance(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + substitutionCost;
      current.push(Math.min(deletion, insertion, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** The closest `MODEL_TIERS` name to an unrecognized top-level key, if close
 * enough to be worth suggesting (e.g. `smal` → `small`, #261). */
function closestTierName(key: string): ModelTierName | undefined {
  const lowered = key.toLowerCase();
  let best: { readonly name: ModelTierName; readonly distance: number } | undefined;
  for (const name of MODEL_TIERS) {
    const distance = editDistance(lowered, name);
    if (best === undefined || distance < best.distance) best = { name, distance };
  }
  return best !== undefined && best.distance <= SUGGESTION_MAX_DISTANCE ? best.name : undefined;
}

/**
 * Fail-closed reader for `workflow_tiers.json`: distinguishes an absent file
 * (legitimate, `{}`) from one that exists but cannot be trusted — bad JSON, a
 * non-object root, an unrecognized top-level key (typo of `small`/`medium`/
 * `big`; rejected with a closest-name suggestion when the edit distance is
 * small, e.g. `smal` → `small`), or a known tier with an unrecognized field
 * or a wrong-typed value. Every caller of the operator tier map (`lohra
 * tiers`, `lohra models`, `list_models`, `WorkflowService`) goes through this
 * function — there is no fail-open sibling left (#261).
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
  for (const key of Object.keys(root)) {
    if ((MODEL_TIERS as readonly string[]).includes(key)) continue;
    const suggestion = closestTierName(key);
    return new TiersError(
      path,
      suggestion === undefined
        ? `unknown top-level key '${key}' (expected one of: ${MODEL_TIERS.join(", ")})`
        : `unknown top-level key '${key}' — did you mean '${suggestion}'?`,
    );
  }
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

export function writeTiers(path: string, tiers: TierMap): void {
  writeFileSync(path, `${JSON.stringify(tiers, null, 2)}\n`, "utf8");
}
