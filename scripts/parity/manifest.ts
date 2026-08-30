import { isAbsolute, posix } from "node:path";

import { HarnessError } from "./errors.js";
import type {
  CaptureRoot,
  CaptureSpec,
  ComparisonClass,
  ComparisonSpec,
  EventCaptureSpec,
  ExpectationSpec,
  FixtureSpec,
  NormalizationSpec,
  OracleGuardSpec,
  RunnerSpec,
  ScenarioManifest,
  SqliteCaptureSpec,
  SqlitePragma,
  SqliteTableSpec,
  TreeCaptureSpec,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessError("MANIFEST_INVALID", `${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new HarnessError("MANIFEST_UNKNOWN_FIELD", `${label} has unknown field ${key}`);
    }
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HarnessError("MANIFEST_INVALID", `${label} must be a string`);
  }
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HarnessError("MANIFEST_INVALID", `${label} must be an array of strings`);
  }
  return value as string[];
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new HarnessError("MANIFEST_INVALID", `${label} must be an array`);
  }
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HarnessError("MANIFEST_INVALID", `${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function relativePath(value: unknown, label: string): string {
  const path = string(value, label).replaceAll("\\", "/");
  const normalized = posix.normalize(path);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new HarnessError(
      "MANIFEST_PATH_ESCAPE",
      `${label} must be relative and remain inside its declared profile/root`,
    );
  }
  return normalized;
}

function root(value: unknown, label: string): CaptureRoot {
  return enumeration(value, ["home", "profile"], label);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new HarnessError("MANIFEST_DUPLICATE", `${label} contains duplicates`);
  }
}

function runner(value: unknown, label: string): RunnerSpec {
  const item = object(value, label);
  exactKeys(item, ["adapter", "executable", "prefixArgs"], label);
  return {
    adapter: enumeration(item.adapter, ["python", "typescript"], `${label}.adapter`),
    executable: string(item.executable, `${label}.executable`),
    prefixArgs: strings(item.prefixArgs ?? [], `${label}.prefixArgs`),
  };
}

function fixture(value: unknown, index: number): FixtureSpec {
  const label = `fixtures[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["root", "path", "encoding", "content"], label);
  const encoding = enumeration(item.encoding, ["utf8", "base64"], `${label}.encoding`);
  const content = string(item.content, `${label}.content`);
  if (
    encoding === "base64" &&
    (content.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
  ) {
    throw new HarnessError("MANIFEST_BASE64", `${label}.content must be canonical base64`);
  }
  return {
    root: root(item.root, `${label}.root`),
    path: relativePath(item.path, `${label}.path`),
    encoding,
    content,
  };
}

function tree(value: unknown): TreeCaptureSpec {
  const item = object(value, "capture.tree");
  exactKeys(item, ["enabled", "root", "exclude"], "capture.tree");
  if (typeof item.enabled !== "boolean") {
    throw new HarnessError("MANIFEST_INVALID", "capture.tree.enabled must be boolean");
  }
  const exclude = array(item.exclude ?? [], "capture.tree.exclude").map((entry, index) =>
    relativePath(entry, `capture.tree.exclude[${String(index)}]`),
  );
  unique(exclude, "capture.tree.exclude");
  return { enabled: item.enabled, root: root(item.root, "capture.tree.root"), exclude };
}

const pragmas = [
  "application_id",
  "foreign_keys",
  "journal_mode",
  "page_size",
  "schema_version",
  "user_version",
] as const satisfies readonly SqlitePragma[];

function table(value: unknown, label: string): SqliteTableSpec {
  const item = object(value, label);
  exactKeys(item, ["name", "orderBy"], label);
  const orderBy = strings(item.orderBy, `${label}.orderBy`);
  if (orderBy.length === 0) {
    throw new HarnessError("MANIFEST_INVALID", `${label}.orderBy must not be empty`);
  }
  unique(orderBy, `${label}.orderBy`);
  return { name: string(item.name, `${label}.name`), orderBy };
}

function sqlite(value: unknown, index: number): SqliteCaptureSpec {
  const label = `capture.sqlite[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["name", "root", "path", "pragmas", "tables"], label);
  const parsedPragmas = array(item.pragmas, `${label}.pragmas`).map((entry, pragmaIndex) =>
    enumeration(entry, pragmas, `${label}.pragmas[${String(pragmaIndex)}]`),
  );
  unique(parsedPragmas, `${label}.pragmas`);
  const tables = array(item.tables, `${label}.tables`).map((entry, tableIndex) =>
    table(entry, `${label}.tables[${String(tableIndex)}]`),
  );
  unique(
    tables.map((entry) => entry.name),
    `${label}.tables names`,
  );
  return {
    name: string(item.name, `${label}.name`),
    root: root(item.root, `${label}.root`),
    path: relativePath(item.path, `${label}.path`),
    pragmas: parsedPragmas,
    tables,
  };
}

function event(value: unknown, index: number): EventCaptureSpec {
  const label = `capture.events[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["name", "root", "path", "format"], label);
  return {
    name: string(item.name, `${label}.name`),
    root: root(item.root, `${label}.root`),
    path: relativePath(item.path, `${label}.path`),
    format: enumeration(item.format, ["json", "jsonl"], `${label}.format`),
  };
}

function capture(value: unknown): CaptureSpec {
  const item = object(value, "capture");
  exactKeys(item, ["tree", "sqlite", "events"], "capture");
  const sqliteItems = array(item.sqlite, "capture.sqlite").map(sqlite);
  const eventItems = array(item.events, "capture.events").map(event);
  unique(
    sqliteItems.map((entry) => entry.name),
    "capture.sqlite names",
  );
  unique(
    eventItems.map((entry) => entry.name),
    "capture.events names",
  );
  return { tree: tree(item.tree), sqlite: sqliteItems, events: eventItems };
}

const comparisonClasses = [
  "byte",
  "format",
  "schema",
  "probe",
  "multiprocess",
  "stub",
] as const satisfies readonly ComparisonClass[];

function comparison(value: unknown, index: number): ComparisonSpec {
  const label = `comparisons[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["class", "field"], label);
  return {
    class: enumeration(item.class, comparisonClasses, `${label}.class`),
    field: string(item.field, `${label}.field`),
  };
}

function expectation(value: unknown, index: number): ExpectationSpec {
  const label = `expectations[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["side", "field", "value", "encoding"], label);
  if (!("value" in item)) {
    throw new HarnessError("MANIFEST_INVALID", `${label}.value is required`);
  }
  const field = string(item.field, `${label}.field`);
  const encoding =
    item.encoding === undefined
      ? undefined
      : enumeration(item.encoding, ["utf8", "base64"], `${label}.encoding`);
  if (encoding !== undefined && field !== "process.stdout" && field !== "process.stderr") {
    throw new HarnessError(
      "MANIFEST_INVALID",
      `${label}.encoding is only valid for process.stdout/process.stderr`,
    );
  }
  return {
    side: enumeration(item.side, ["oracle", "candidate", "both"], `${label}.side`),
    field,
    value: item.value,
    ...(encoding === undefined ? {} : { encoding }),
  };
}

function normalization(value: unknown, index: number): NormalizationSpec {
  const label = `normalizations[${String(index)}]`;
  const item = object(value, label);
  const kind = enumeration(
    item.kind,
    ["replace-runtime-path", "replace-text", "replace-json-pointer"],
    `${label}.kind`,
  );
  const field = string(item.field, `${label}.field`);
  if (kind === "replace-runtime-path") {
    exactKeys(item, ["field", "kind", "source", "replacement"], label);
    return {
      field,
      kind,
      source: root(item.source, `${label}.source`),
      replacement: string(item.replacement, `${label}.replacement`),
    };
  }
  if (kind === "replace-text") {
    exactKeys(item, ["field", "kind", "search", "replacement"], label);
    const search = string(item.search, `${label}.search`);
    if (search.length === 0) {
      throw new HarnessError("MANIFEST_INVALID", `${label}.search must not be empty`);
    }
    return {
      field,
      kind,
      search,
      replacement: string(item.replacement, `${label}.replacement`),
    };
  }
  exactKeys(item, ["field", "kind", "pointer", "replacement"], label);
  if (!("replacement" in item)) {
    throw new HarnessError("MANIFEST_INVALID", `${label}.replacement is required`);
  }
  return {
    field,
    kind,
    pointer: string(item.pointer, `${label}.pointer`),
    replacement: item.replacement,
  };
}

function guard(value: unknown): OracleGuardSpec {
  const item = object(value, "oracleGuard");
  exactKeys(item, ["expectedCommit", "expectedVersion"], "oracleGuard");
  return {
    expectedCommit: string(item.expectedCommit, "oracleGuard.expectedCommit"),
    expectedVersion: string(item.expectedVersion, "oracleGuard.expectedVersion"),
  };
}

export function parseScenarioManifest(value: unknown): ScenarioManifest {
  const item = object(value, "manifest");
  exactKeys(
    item,
    [
      "schemaVersion",
      "id",
      "description",
      "argv",
      "environment",
      "fixtures",
      "runners",
      "limits",
      "capture",
      "comparisons",
      "expectations",
      "normalizations",
      "oracleGuard",
    ],
    "manifest",
  );
  if (item.schemaVersion !== 1) {
    throw new HarnessError("MANIFEST_VERSION", "schemaVersion must be 1");
  }
  const id = string(item.id, "id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new HarnessError("MANIFEST_INVALID", "id must be a lowercase kebab-case slug");
  }
  const environment = object(item.environment, "environment");
  exactKeys(environment, ["allow", "set"], "environment");
  const allow = strings(environment.allow, "environment.allow");
  unique(allow, "environment.allow");
  const setObject = object(environment.set, "environment.set");
  const set = Object.fromEntries(
    Object.entries(setObject).map(([key, entry]) => [key, string(entry, `environment.set.${key}`)]),
  );
  if (!("PATH" in set)) {
    throw new HarnessError("MANIFEST_ENV_PATH", "environment.set.PATH is required");
  }
  const runnersObject = object(item.runners, "runners");
  exactKeys(runnersObject, ["oracle", "candidate"], "runners");
  const limitsObject = object(item.limits, "limits");
  exactKeys(limitsObject, ["timeoutMs", "maxOutputBytes"], "limits");
  const timeoutMs = limitsObject.timeoutMs;
  const maxOutputBytes = limitsObject.maxOutputBytes;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new HarnessError("MANIFEST_LIMIT", "limits.timeoutMs must be an integer from 1 to 60000");
  }
  if (
    typeof maxOutputBytes !== "number" ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16_777_216
  ) {
    throw new HarnessError(
      "MANIFEST_LIMIT",
      "limits.maxOutputBytes must be an integer from 1 to 16777216",
    );
  }
  const parsedCapture = capture(item.capture);
  const validField = (field: string): boolean =>
    ["process.exitCode", "process.signal", "process.stdout", "process.stderr", "tree"].includes(
      field,
    ) ||
    parsedCapture.sqlite.some(
      (entry) => field === `sqlite.${entry.name}` || field.startsWith(`sqlite.${entry.name}.`),
    ) ||
    parsedCapture.events.some(
      (entry) => field === `events.${entry.name}` || field.startsWith(`events.${entry.name}.`),
    );
  const comparisons = array(item.comparisons, "comparisons").map(comparison);
  if (comparisons.length === 0) {
    throw new HarnessError("MANIFEST_INVALID", "comparisons must not be empty");
  }
  unique(
    comparisons.map((entry) => entry.field),
    "comparisons fields",
  );
  for (const entry of comparisons) {
    if (!validField(entry.field)) {
      throw new HarnessError(
        "MANIFEST_COMPARISON_FIELD",
        `comparison field ${entry.field} is not declared by process/capture`,
      );
    }
  }
  const expectations = array(item.expectations, "expectations").map(expectation);
  for (const entry of expectations) {
    if (!validField(entry.field)) {
      throw new HarnessError(
        "MANIFEST_EXPECTATION_FIELD",
        `expectation field ${entry.field} is not declared by process/capture`,
      );
    }
  }
  const normalizations = array(item.normalizations, "normalizations").map(normalization);
  const comparedFields = new Set(comparisons.map((entry) => entry.field));
  for (const rule of normalizations) {
    if (!comparedFields.has(rule.field)) {
      throw new HarnessError(
        "MANIFEST_NORMALIZATION_FIELD",
        `normalization field ${rule.field} has no declared comparison`,
      );
    }
  }
  const parsedRunners = {
    oracle: runner(runnersObject.oracle, "runners.oracle"),
    candidate: runner(runnersObject.candidate, "runners.candidate"),
  };
  const usesOracle = Object.values(parsedRunners).some(
    (entry) => entry.executable === "oracle-lohra",
  );
  if (usesOracle && item.oracleGuard === undefined) {
    throw new HarnessError("MANIFEST_GUARD", "oracleGuard is required for oracle-lohra");
  }
  const parsed: ScenarioManifest = {
    schemaVersion: 1,
    id,
    description: string(item.description, "description"),
    argv: strings(item.argv, "argv"),
    environment: { allow, set },
    fixtures: array(item.fixtures, "fixtures").map(fixture),
    runners: parsedRunners,
    limits: { timeoutMs, maxOutputBytes },
    capture: parsedCapture,
    comparisons,
    expectations,
    normalizations,
    ...(item.oracleGuard === undefined ? {} : { oracleGuard: guard(item.oracleGuard) }),
  };
  return parsed;
}
