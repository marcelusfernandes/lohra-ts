#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pure = [
  ["build-core", "/messages/0/content", "TOP"],
  ["build-boundaries", "/max_tokens", 0],
  ["build-unicode", "/messages/0/tool_calls/1/function/arguments", '{"k": "a\\u007fb"}'],
  ["build-copy", "/tools_copied", true],
  ["normalize-core", "/finish_reason", "stop"],
  ["normalize-finish", "/3", "tool_calls"],
  ["normalize-tools", "/tool_calls/0/arguments", "{}"],
  ["usage-basic", "/reasoning_tokens", 7],
  ["usage-fallback", "/0/cache_read_tokens", 40],
  ["usage-negative", "/1/cache_read_tokens", -5],
  ["stream-content-reasoning", "/result/reasoning", null],
  ["stream-usage", "/usage/input_tokens", 9],
  ["stream-tools", "/tool_calls/0/id", "c2"],
  ["stream-incomplete", "/0", "incomplete tool-call stream"],
  [
    "stream-orphan",
    "/warnings/0",
    "discarding 1 orphaned tool-call stream slot(s); finish_reason='stop'",
  ],
  ["stream-callbacks", "/callbacks/3/0", "reasoning"],
  ["error-classification", "/0", "quota_exhausted"],
  ["retry-after", "/1", 11],
  ["client-timeout-prose-retry", "/requests/1/stream", true],
  ["provider-routing", "/alias", "openrouter"],
];

const http = [
  [
    "client-nonstream-del-no-tools",
    "client-nonstream",
    "chat-del",
    "/response/content",
    `a${String.fromCharCode(0x7f)}b`,
    1,
  ],
  [
    "client-stream-no-tools",
    "client-stream",
    "chat-stream",
    "/response/content",
    "STUB-OK: deterministic reply",
    1,
  ],
  [
    "client-stream-nodone-no-tools",
    "client-stream",
    "chat-stream-nodone",
    "/response/content",
    "STUB-OK: deterministic reply",
    1,
  ],
  [
    "client-stream-options-retry-no-tools",
    "client-stream",
    "chat-stream-options-400",
    "/response/content",
    "STUB-OK: deterministic reply",
    2,
  ],
  ["client-http-401-no-tools", "client-nonstream", "chat-http-401", "/status_code", 401, 1],
  ["client-http-500-no-tools", "client-nonstream", "chat-http-500", "/status_code", 500, 3],
];

const environment = {
  allow: [],
  set: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUTF8: "1",
    NO_COLOR: "1",
    COLUMNS: "80",
    TZ: "UTC",
    HOME: "{{home}}",
    CODEX_HOME: "{{home}}/codex",
    TMPDIR: "{{home}}/tmp",
  },
};

const guard = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
  expectedPythonVersion: "3.12.10",
  expectedPackages: { openai: "3.6.0", httpx: "0.28.1" },
};

const capture = {
  tree: { enabled: false, root: "home", exclude: [] },
  sqlite: [],
  events: [],
};

const comparisons = [
  { class: "byte", field: "process.exitCode" },
  { class: "byte", field: "process.signal" },
  { class: "probe", field: "process.stdout" },
  { class: "byte", field: "process.stderr" },
];

function runners(oracleMode, candidateMode = oracleMode) {
  return {
    oracle: {
      adapter: "python",
      executable: "oracle-python",
      prefixArgs: ["{{projectRoot}}/scripts/parity/chat-completions/oracle_driver.py", oracleMode],
      cwd: "sandbox",
    },
    candidate: {
      adapter: "typescript",
      executable: "node",
      prefixArgs: [
        "{{projectRoot}}/scripts/parity/chat-completions/candidate-driver.mjs",
        candidateMode,
      ],
      cwd: "sandbox",
    },
  };
}

function base(id, runnerSpec) {
  return {
    schemaVersion: 1,
    id: `t07-${id}`,
    description: `T07 chat-completions transport: ${id}`,
    argv: [],
    environment,
    preconditions: [],
    fixtures: [],
    runners: runnerSpec,
    limits: { timeoutMs: 30_000, maxOutputBytes: 4_194_304 },
    capture,
    comparisons,
    expectations: [
      { side: "both", field: "process.exitCode", value: 0 },
      { side: "both", field: "process.signal", value: null },
      { side: "both", field: "process.stderr", encoding: "utf8", value: "" },
    ],
    normalizations: [],
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: guard,
  };
}

const output = resolve("scripts/parity/scenarios");
mkdirSync(output, { recursive: true });
for (const [id, pointer, value] of pure) {
  const manifest = base(id, runners(id));
  manifest.expectations.push({
    side: "both",
    field: "process.stdout",
    encoding: "utf8",
    pointer,
    value,
  });
  writeFileSync(resolve(output, `t07-${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

const comparedHeaders = [
  "authorization",
  "accept",
  "content-type",
  "host",
  "x-stainless-retry-count",
];
const excludedHeaders = [
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
];
for (const [id, mode, fixture, pointer, value, posts] of http) {
  const manifest = base(id, runners(mode));
  manifest.preconditions = [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }];
  manifest.capture = {
    tree: { enabled: false, root: "home", exclude: [] },
    sqlite: [],
    events: [
      { name: "requests", root: "profile", path: "stub-requests.jsonl", format: "jsonl" },
      {
        name: "requestsRaw",
        root: "profile",
        path: "stub-requests-raw.jsonl",
        format: "jsonl",
        projection: "raw-only",
      },
      { name: "summary", root: "profile", path: "stub-summary.json", format: "json" },
      { name: "assertions", root: "profile", path: "stub-assertions.json", format: "json" },
    ],
  };
  manifest.comparisons = [
    ...comparisons,
    { class: "stub", field: "events.requests" },
    { class: "stub", field: "events.summary" },
    { class: "stub", field: "events.assertions" },
  ];
  manifest.expectations.push(
    { side: "both", field: "process.stdout", encoding: "utf8", pointer, value },
    {
      side: "both",
      field: "events.summary",
      value: {
        exists: true,
        records: {
          gets: 0,
          posts,
          sequence: Array.from({ length: posts }, () => "POST /v1/chat/completions"),
        },
      },
    },
    {
      side: "both",
      field: "events.assertions",
      value: { exists: true, records: { valid: true, failures: [] } },
    },
  );
  manifest.stub = {
    state: "up-with-models",
    fixture,
    requestLog: { comparedHeaders, excludedHeaders },
  };
  writeFileSync(resolve(output, `t07-${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const [id, oracleMode, candidateMode, pointer, value] of [
  [
    "json-stringify-mutant",
    "build-unicode",
    "json-stringify-mutant",
    "/messages/0/tool_calls/1/function/arguments",
    '{"k": "a\\u007fb"}',
  ],
  [
    "stream-reasoning-mutant",
    "stream-content-reasoning",
    "stream-reasoning-mutant",
    "/result/reasoning",
    null,
  ],
]) {
  const manifest = base(id, runners(oracleMode, candidateMode));
  manifest.expectations.push({
    side: "oracle",
    field: "process.stdout",
    encoding: "utf8",
    pointer,
    value,
  });
  writeFileSync(resolve(output, `t07-${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}
