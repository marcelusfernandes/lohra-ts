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
  PreconditionSpec,
  RunnerSpec,
  ScenarioManifest,
  ScrubSpec,
  SqliteCaptureSpec,
  SqlitePragma,
  SqliteTableSpec,
  TreeCaptureSpec,
  StubFixture,
  StubLaneStep,
  StubSpec,
  StubToolStep,
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

function scrub(value: unknown): ScrubSpec {
  const item = object(value, "scrub");
  exactKeys(item, ["fixtureTokens", "operatorCredentials"], "scrub");
  if (typeof item.fixtureTokens !== "boolean" || typeof item.operatorCredentials !== "boolean") {
    throw new HarnessError("MANIFEST_INVALID", "scrub fields must be boolean");
  }
  return {
    fixtureTokens: item.fixtureTokens,
    operatorCredentials: item.operatorCredentials,
  };
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

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const record = object(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new HarnessError("MANIFEST_INVALID", `${label}.${key} must be a string`);
    }
  }
  return record as Record<string, string>;
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
  exactKeys(item, ["adapter", "executable", "prefixArgs", "cwd"], label);
  return {
    adapter: enumeration(item.adapter, ["python", "typescript"], `${label}.adapter`),
    executable: string(item.executable, `${label}.executable`),
    prefixArgs: strings(item.prefixArgs ?? [], `${label}.prefixArgs`),
    cwd:
      item.cwd === undefined
        ? "sandbox"
        : enumeration(item.cwd, ["home", "profile", "sandbox"], `${label}.cwd`),
  };
}

const comparedRequestHeaders = [
  "authorization",
  "accept",
  "content-type",
  "host",
  "x-stainless-retry-count",
] as const;
const excludedRequestHeaders = [
  "accept-encoding",
  "connection",
  "content-length",
  "user-agent",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-async",
  "x-stainless-read-timeout",
] as const;
const stubFixtures = [
  "doctor",
  "chat-text",
  "chat-del",
  "chat-stream",
  "chat-stream-nodone",
  "chat-stream-options-400",
  "chat-tool",
  "chat-tool-stream",
  "chat-tool-unknown",
  "chat-http-401",
  "chat-http-500",
  "chat-no-usage",
  "chat-incomplete-tool",
  "chat-tool-sequence",
  "side-divergent",
  "chat-lane-script",
] as const satisfies readonly StubFixture[];

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

function stub(value: unknown): StubSpec {
  const item = object(value, "stub");
  exactKeys(item, ["state", "fixture", "requestLog", "toolSequence", "laneSteps"], "stub");
  const requestLog = object(item.requestLog, "stub.requestLog");
  exactKeys(requestLog, ["comparedHeaders", "excludedHeaders"], "stub.requestLog");
  const comparedHeaders = strings(requestLog.comparedHeaders, "stub.requestLog.comparedHeaders");
  const excludedHeaders = strings(requestLog.excludedHeaders, "stub.requestLog.excludedHeaders");
  unique(comparedHeaders, "stub.requestLog.comparedHeaders");
  unique(excludedHeaders, "stub.requestLog.excludedHeaders");
  if (
    !sameMembers(comparedHeaders, comparedRequestHeaders) ||
    !sameMembers(excludedHeaders, excludedRequestHeaders)
  ) {
    throw new HarnessError(
      "MANIFEST_HEADER_POLICY",
      "stub request header policy must classify the versioned compared and excluded headers",
    );
  }
  const toolSequence = array(item.toolSequence ?? [], "stub.toolSequence").map(
    (raw, index): StubToolStep => {
      const label = `stub.toolSequence[${String(index)}]`;
      const step = object(raw, label);
      exactKeys(step, ["calls"], label);
      const calls = array(step.calls, `${label}.calls`).map((rawCall, callIndex) => {
        const callLabel = `${label}.calls[${String(callIndex)}]`;
        const call = object(rawCall, callLabel);
        exactKeys(call, ["name", "argumentsRaw", "expectedResult", "validation"], callLabel);
        return {
          name: string(call.name, `${callLabel}.name`),
          argumentsRaw: string(call.argumentsRaw, `${callLabel}.argumentsRaw`),
          expectedResult: string(call.expectedResult, `${callLabel}.expectedResult`),
          validation: enumeration(call.validation, ["exact", "skip"], `${callLabel}.validation`),
        };
      });
      if (calls.length === 0)
        throw new HarnessError("MANIFEST_STUB_TOOLS", `${label}.calls must not be empty`);
      return { calls };
    },
  );
  const laneStepsRaw = item.laneSteps;
  const laneSteps: Record<string, readonly StubLaneStep[]> = {};
  if (laneStepsRaw !== undefined) {
    const lanes = object(laneStepsRaw, "stub.laneSteps");
    for (const [lane, rawSteps] of Object.entries(lanes)) {
      laneSteps[lane] = array(rawSteps, `stub.laneSteps.${lane}`).map(
        (raw, index): StubLaneStep => {
          const label = `stub.laneSteps.${lane}[${String(index)}]`;
          const step = object(raw, label);
          exactKeys(
            step,
            [
              "kind",
              "content",
              "calls",
              "status",
              "message",
              "headers",
              "signal",
              "awaitSignal",
              "gate",
              "openGate",
            ],
            label,
          );
          const kind = enumeration(
            step.kind,
            ["text", "tool_calls", "http_error"],
            `${label}.kind`,
          );
          if (kind === "text" && typeof step.content !== "string") {
            throw new HarnessError(
              "MANIFEST_INVALID",
              `${label}.content must be a string for kind "text"`,
            );
          }
          if (kind === "http_error" && typeof step.status !== "number") {
            throw new HarnessError(
              "MANIFEST_INVALID",
              `${label}.status must be a number for kind "http_error"`,
            );
          }
          const calls =
            step.calls === undefined
              ? undefined
              : array(step.calls, `${label}.calls`).map((rawCall, callIndex) => {
                  const callLabel = `${label}.calls[${String(callIndex)}]`;
                  const call = object(rawCall, callLabel);
                  exactKeys(call, ["name", "argumentsRaw"], callLabel);
                  return {
                    name: string(call.name, `${callLabel}.name`),
                    argumentsRaw: string(call.argumentsRaw, `${callLabel}.argumentsRaw`),
                  };
                });
          if (kind === "tool_calls" && (calls === undefined || calls.length === 0)) {
            throw new HarnessError("MANIFEST_STUB_LANE_STEP", `${label}.calls must not be empty`);
          }
          return {
            kind,
            ...(step.content === undefined
              ? {}
              : { content: string(step.content, `${label}.content`) }),
            ...(calls === undefined ? {} : { calls }),
            ...(step.status === undefined ? {} : { status: step.status as number }),
            ...(step.message === undefined
              ? {}
              : { message: string(step.message, `${label}.message`) }),
            ...(step.headers === undefined
              ? {}
              : { headers: stringRecord(step.headers, `${label}.headers`) }),
            ...(step.signal === undefined
              ? {}
              : { signal: string(step.signal, `${label}.signal`) }),
            ...(step.awaitSignal === undefined
              ? {}
              : { awaitSignal: string(step.awaitSignal, `${label}.awaitSignal`) }),
            ...(step.gate === undefined ? {} : { gate: string(step.gate, `${label}.gate`) }),
            ...(step.openGate === undefined
              ? {}
              : { openGate: string(step.openGate, `${label}.openGate`) }),
          };
        },
      );
    }
  }
  return {
    state: enumeration(item.state, ["down", "up-with-models", "up-empty-models"], "stub.state"),
    fixture: enumeration(item.fixture, stubFixtures, "stub.fixture"),
    requestLog: { comparedHeaders, excludedHeaders },
    ...(toolSequence.length === 0 ? {} : { toolSequence }),
    ...(Object.keys(laneSteps).length === 0 ? {} : { laneSteps }),
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
  "encoding",
  "foreign_keys",
  "journal_mode",
  "page_size",
  "quick_check",
  "schema_version",
  "user_version",
  "wal_autocheckpoint",
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
  exactKeys(item, ["name", "root", "path", "pragmas", "tables", "projection"], label);
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
    projection:
      item.projection === undefined
        ? "include"
        : enumeration(item.projection, ["include", "raw-only"], `${label}.projection`),
  };
}

function event(value: unknown, index: number): EventCaptureSpec {
  const label = `capture.events[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["name", "root", "path", "format", "projection"], label);
  return {
    name: string(item.name, `${label}.name`),
    root: root(item.root, `${label}.root`),
    path: relativePath(item.path, `${label}.path`),
    format: enumeration(item.format, ["json", "jsonl"], `${label}.format`),
    projection:
      item.projection === undefined
        ? "include"
        : enumeration(item.projection, ["include", "raw-only"], `${label}.projection`),
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
  exactKeys(item, ["side", "field", "value", "encoding", "pointer", "pointerPattern"], label);
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
  if (item.pointer !== undefined) {
    const pointer = string(item.pointer, `${label}.pointer`);
    if (!pointer.startsWith("/") || pointer === "/") {
      throw new HarnessError("MANIFEST_INVALID", `${label}.pointer must address a child value`);
    }
  }
  if (item.pointerPattern !== undefined) {
    const pointerPattern = string(item.pointerPattern, `${label}.pointerPattern`);
    if (
      !pointerPattern.startsWith("/") ||
      pointerPattern === "/" ||
      !pointerPattern.split("/").includes("*")
    ) {
      throw new HarnessError(
        "MANIFEST_INVALID",
        `${label}.pointerPattern must address child values and include a wildcard segment`,
      );
    }
    if (item.pointer !== undefined) {
      throw new HarnessError(
        "MANIFEST_INVALID",
        `${label} cannot declare both pointer and pointerPattern`,
      );
    }
  }
  return {
    side: enumeration(item.side, ["oracle", "candidate", "both"], `${label}.side`),
    field,
    value: item.value,
    ...(encoding === undefined ? {} : { encoding }),
    ...(item.pointer === undefined ? {} : { pointer: string(item.pointer, `${label}.pointer`) }),
    ...(item.pointerPattern === undefined
      ? {}
      : { pointerPattern: string(item.pointerPattern, `${label}.pointerPattern`) }),
  };
}

function normalization(value: unknown, index: number): NormalizationSpec {
  const label = `normalizations[${String(index)}]`;
  const item = object(value, label);
  const kind = enumeration(
    item.kind,
    ["replace-runtime-path", "replace-text", "replace-json-pointer", "replace-regex"],
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
  if (kind === "replace-regex") {
    exactKeys(item, ["field", "kind", "pattern", "replacement", "hashOnly"], label);
    const pattern = string(item.pattern, `${label}.pattern`);
    if (pattern.length === 0 || pattern.length > 256) {
      throw new HarnessError("MANIFEST_INVALID", `${label}.pattern must contain 1..256 chars`);
    }
    try {
      new RegExp(pattern, "g");
    } catch (error) {
      throw new HarnessError("MANIFEST_INVALID", `${label}.pattern is invalid`, { cause: error });
    }
    if ("hashOnly" in item && typeof item.hashOnly !== "boolean") {
      throw new HarnessError("MANIFEST_INVALID", `${label}.hashOnly must be a boolean`);
    }
    return {
      field,
      kind,
      pattern,
      replacement: string(item.replacement, `${label}.replacement`),
      ...(item.hashOnly === true ? { hashOnly: true } : {}),
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
  exactKeys(
    item,
    ["expectedCommit", "expectedVersion", "expectedPythonVersion", "expectedPackages"],
    "oracleGuard",
  );
  const packages =
    item.expectedPackages === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(object(item.expectedPackages, "oracleGuard.expectedPackages")).map(
            ([name, version]) => [name, string(version, `oracleGuard.expectedPackages.${name}`)],
          ),
        );
  return {
    expectedCommit: string(item.expectedCommit, "oracleGuard.expectedCommit"),
    expectedVersion: string(item.expectedVersion, "oracleGuard.expectedVersion"),
    ...(item.expectedPythonVersion === undefined
      ? {}
      : {
          expectedPythonVersion: string(
            item.expectedPythonVersion,
            "oracleGuard.expectedPythonVersion",
          ),
        }),
    ...(packages === undefined ? {} : { expectedPackages: packages }),
  };
}

function precondition(value: unknown, index: number): PreconditionSpec {
  const label = `preconditions[${String(index)}]`;
  const item = object(value, label);
  exactKeys(item, ["kind", "host", "port"], label);
  const kind = enumeration(item.kind, ["tcp-port-closed"], `${label}.kind`);
  const host = string(item.host, `${label}.host`);
  if (host !== "127.0.0.1") {
    throw new HarnessError("MANIFEST_PRECONDITION", `${label}.host must be loopback 127.0.0.1`);
  }
  if (
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port < 1 ||
    item.port > 65_535
  ) {
    throw new HarnessError(
      "MANIFEST_PRECONDITION",
      `${label}.port must be an integer from 1 to 65535`,
    );
  }
  return { kind, host, port: item.port };
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
      "preconditions",
      "fixtures",
      "runners",
      "limits",
      "capture",
      "comparisons",
      "expectations",
      "normalizations",
      "scrub",
      "stub",
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
    preconditions: array(item.preconditions ?? [], "preconditions").map(precondition),
    fixtures: array(item.fixtures, "fixtures").map(fixture),
    runners: parsedRunners,
    limits: { timeoutMs, maxOutputBytes },
    capture: parsedCapture,
    comparisons,
    expectations,
    normalizations,
    ...(item.scrub === undefined ? {} : { scrub: scrub(item.scrub) }),
    ...(item.stub === undefined ? {} : { stub: stub(item.stub) }),
    ...(item.oracleGuard === undefined ? {} : { oracleGuard: guard(item.oracleGuard) }),
  };
  return parsed;
}
