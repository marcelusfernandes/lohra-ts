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
  if (typeof value === "string") {
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
  let matches = 0;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const count = entry.split(search).length - 1;
      matches += count;
      return entry.replaceAll(search, replacement);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === "object" && entry !== null) {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    }
    return entry;
  };
  const replaced = visit(value);
  if (matches === 0) {
    throw new HarnessError(
      "NORMALIZATION_MISS",
      `Normalization for ${field} did not find its declared value`,
    );
  }
  return replaced;
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
  if (streamField(field)) {
    if (typeof value !== "string") {
      throw new HarnessError("NORMALIZATION_TYPE", `Normalization field ${field} is not text`);
    }
    const decoded = Buffer.from(value, "base64").toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch (error) {
      throw new HarnessError("NORMALIZATION_JSON", `${field} is not valid JSON`, { cause: error });
    }
    const parts = pointerParts(pointer);
    let current = parsed;
    for (const part of parts) {
      if (typeof current !== "object" || current === null || !(part in current)) {
        throw new HarnessError(
          "NORMALIZATION_POINTER_MISS",
          `JSON Pointer ${pointer} does not exist in ${field}`,
        );
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (parts.length !== 1) {
      throw new HarnessError(
        "NORMALIZATION_POINTER",
        "Stream JSON Pointer currently requires one top-level object key",
      );
    }
    const key = JSON.stringify(parts[0]);
    const expression = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "g");
    const locations = [...decoded.matchAll(expression)];
    if (locations.length !== 1 || locations[0]?.index === undefined) {
      throw new HarnessError(
        "NORMALIZATION_POINTER_MISS",
        `JSON Pointer ${pointer} is not uniquely addressable in ${field}`,
      );
    }
    let start = locations[0].index + locations[0][0].length;
    while (/\s/.test(decoded[start] ?? "")) start += 1;
    let end = start;
    if (decoded[start] === '"') {
      end += 1;
      let escaped = false;
      while (end < decoded.length) {
        const character = decoded[end];
        end += 1;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') break;
      }
    } else {
      while (end < decoded.length && !/[\s,}\]]/.test(decoded[end] as string)) end += 1;
    }
    const encodedReplacement = JSON.stringify(replacement);
    const replaced = `${decoded.slice(0, start)}${encodedReplacement}${decoded.slice(end)}`;
    return Buffer.from(replaced).toString("base64");
  }
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

function replaceRegex(
  value: unknown,
  pattern: string,
  replacement: string,
  field: string,
): unknown {
  if (typeof value === "string") {
    const decoded = streamField(field) ? Buffer.from(value, "base64").toString("utf8") : value;
    const expression = new RegExp(pattern, "g");
    const matches = [...decoded.matchAll(expression)];
    if (matches.length === 0) {
      throw new HarnessError(
        "NORMALIZATION_MISS",
        `Normalization for ${field} did not match its declared pattern`,
      );
    }
    if (matches.length > 16) {
      throw new HarnessError("NORMALIZATION_LIMIT", `Normalization for ${field} exceeded 16 matches`);
    }
    const replaced = decoded.replace(expression, replacement);
    return streamField(field) ? Buffer.from(replaced).toString("base64") : replaced;
  }
  // Structured (non-stream) fields, e.g. events.requests/sqlite.db, are
  // objects/arrays, not raw text — walk them the same way replaceString's
  // recursive-object case already does, applying the pattern to every
  // string leaf rather than requiring the caller to pin an exact JSON
  // Pointer to a value that embeds today's date (which changes daily).
  let totalMatches = 0;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const expression = new RegExp(pattern, "g");
      const matches = [...entry.matchAll(expression)];
      totalMatches += matches.length;
      return entry.replace(expression, replacement);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === "object" && entry !== null) {
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    }
    return entry;
  };
  const replaced = visit(value);
  if (totalMatches === 0) {
    throw new HarnessError(
      "NORMALIZATION_MISS",
      `Normalization for ${field} did not match its declared pattern`,
    );
  }
  if (totalMatches > 16) {
    throw new HarnessError("NORMALIZATION_LIMIT", `Normalization for ${field} exceeded 16 matches`);
  }
  return replaced;
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
  if (rule.kind === "replace-regex") {
    return replaceRegex(value, rule.pattern, rule.replacement, rule.field);
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
    const fieldRules = options.normalizations.filter((entry) => entry.field === comparison.field);
    // Rules that affect the verdict (everything except hashOnly) apply
    // first — a session id or a temp-directory path is EXPECTED to differ
    // between two independent processes, so stripping it before comparing
    // is correct. hashOnly rules apply AFTER the verdict below: they exist
    // for content that's supposed to be identical across both sides (e.g.
    // today's date), where a mismatch is itself the bug — normalizing it
    // away before comparing would hide exactly the divergence a hashOnly
    // rule's own field was added to catch.
    for (const rule of fieldRules) {
      if (rule.kind === "replace-regex" && rule.hashOnly === true) continue;
      oracleValue = applyRule(oracleValue, rule, options.runtimeValues.oracle);
      candidateValue = applyRule(candidateValue, rule, options.runtimeValues.candidate);
    }
    if (canonicalJson(oracleValue) !== canonicalJson(candidateValue)) {
      differences.push({
        field: comparison.field,
        class: comparison.class,
        oracle: oracleValue,
        candidate: candidateValue,
      });
    }
    for (const rule of fieldRules) {
      if (!(rule.kind === "replace-regex" && rule.hashOnly === true)) continue;
      oracleValue = applyRule(oracleValue, rule, options.runtimeValues.oracle);
      candidateValue = applyRule(candidateValue, rule, options.runtimeValues.candidate);
    }
    normalized[comparison.field] = { oracle: oracleValue, candidate: candidateValue };
  }
  return {
    verdict: differences.length === 0 ? "match" : "divergent",
    differences,
    normalized,
  };
}
