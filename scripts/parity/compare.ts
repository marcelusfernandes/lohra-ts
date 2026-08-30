import { canonicalJson } from "./canonical.js";
import { HarnessError } from "./errors.js";
import type {
  ComparisonResult,
  ComparisonSpec,
  NormalizationSpec,
  RunRecord,
  RuntimePaths,
} from "./types.js";

interface CompareOptions {
  readonly comparisons: readonly ComparisonSpec[];
  readonly normalizations: readonly NormalizationSpec[];
  readonly runtimeValues: {
    readonly oracle: Pick<RuntimePaths, "home" | "profile">;
    readonly candidate: Pick<RuntimePaths, "home" | "profile">;
  };
}

export function readRunField(record: RunRecord, field: string): unknown {
  let current: unknown = record;
  for (const part of field.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new HarnessError("COMPARISON_FIELD", `Comparison field ${field} does not exist`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function streamField(field: string): boolean {
  return field === "process.stdout" || field === "process.stderr";
}

function replaceString(
  value: unknown,
  search: string,
  replacement: string,
  field: string,
): unknown {
  if (typeof value !== "string") {
    throw new HarnessError("NORMALIZATION_TYPE", `Normalization field ${field} is not text`);
  }
  const decoded = streamField(field) ? Buffer.from(value, "base64").toString("utf8") : value;
  if (!decoded.includes(search)) {
    throw new HarnessError(
      "NORMALIZATION_MISS",
      `Normalization for ${field} did not find its declared value`,
    );
  }
  const replaced = decoded.replaceAll(search, replacement);
  return streamField(field) ? Buffer.from(replaced).toString("base64") : replaced;
}

function pointerParts(pointer: string): readonly string[] {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new HarnessError(
      "NORMALIZATION_POINTER",
      "JSON Pointer must start with / and address a child value",
    );
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function replacePointer(
  value: unknown,
  pointer: string,
  replacement: unknown,
  field: string,
): unknown {
  const clone = structuredClone(value);
  const parts = pointerParts(pointer);
  let parent: unknown = clone;
  for (const part of parts.slice(0, -1)) {
    if (typeof parent !== "object" || parent === null || !(part in parent)) {
      throw new HarnessError(
        "NORMALIZATION_POINTER_MISS",
        `JSON Pointer ${pointer} does not exist in ${field}`,
      );
    }
    parent = (parent as Record<string, unknown>)[part];
  }
  const last = parts.at(-1);
  if (last === undefined || typeof parent !== "object" || parent === null || !(last in parent)) {
    throw new HarnessError(
      "NORMALIZATION_POINTER_MISS",
      `JSON Pointer ${pointer} does not exist in ${field}`,
    );
  }
  (parent as Record<string, unknown>)[last] = structuredClone(replacement);
  return clone;
}

function applyRule(
  value: unknown,
  rule: NormalizationSpec,
  paths: Pick<RuntimePaths, "home" | "profile">,
): unknown {
  if (rule.kind === "replace-runtime-path") {
    return replaceString(value, paths[rule.source], rule.replacement, rule.field);
  }
  if (rule.kind === "replace-text") {
    return replaceString(value, rule.search, rule.replacement, rule.field);
  }
  return replacePointer(value, rule.pointer, rule.replacement, rule.field);
}

export function compareRuns(
  oracle: RunRecord,
  candidate: RunRecord,
  options: CompareOptions,
): ComparisonResult {
  const differences = [];
  const normalized: Record<string, { oracle: unknown; candidate: unknown }> = {};
  for (const comparison of options.comparisons) {
    let oracleValue = structuredClone(readRunField(oracle, comparison.field));
    let candidateValue = structuredClone(readRunField(candidate, comparison.field));
    for (const rule of options.normalizations.filter((entry) => entry.field === comparison.field)) {
      oracleValue = applyRule(oracleValue, rule, options.runtimeValues.oracle);
      candidateValue = applyRule(candidateValue, rule, options.runtimeValues.candidate);
    }
    normalized[comparison.field] = { oracle: oracleValue, candidate: candidateValue };
    if (canonicalJson(oracleValue) !== canonicalJson(candidateValue)) {
      differences.push({
        field: comparison.field,
        class: comparison.class,
        oracle: oracleValue,
        candidate: candidateValue,
      });
    }
  }
  return {
    verdict: differences.length === 0 ? "match" : "divergent",
    differences,
    normalized,
  };
}
