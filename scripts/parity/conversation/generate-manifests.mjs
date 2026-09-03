#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const scenarios = resolve("scripts/parity/manifests/t08");
mkdirSync(scenarios, { recursive: true });

const environment = {
  allow: [],
  set: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUTF8: "1",
    PYTHONHASHSEED: "0",
    NO_COLOR: "1",
    LOHRA_NO_WIZARD: "1",
    COLUMNS: "80",
    TZ: "UTC",
    HOME: "{{home}}",
    LOHRA_HOME: "{{home}}/.lohra",
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

function runners(mode = "single", mutant) {
  const candidateMode = mutant === undefined ? mode : `${mode}@${mutant}`;
  return {
    oracle: {
      adapter: "python",
      executable: "oracle-python",
      prefixArgs: ["{{projectRoot}}/scripts/parity/conversation/oracle_driver.py", mode],
      cwd: "profile",
    },
    candidate: {
      adapter: "typescript",
      executable: "node",
      prefixArgs: [
        "{{projectRoot}}/scripts/parity/conversation/candidate-driver.mjs",
        candidateMode,
      ],
      cwd: "profile",
    },
  };
}

function dbCapture(projection = "include") {
  return {
    name: "db",
    root: "home",
    path: ".lohra/state.db",
    pragmas: [
      "application_id",
      "encoding",
      "journal_mode",
      "page_size",
      "quick_check",
      "user_version",
    ],
    tables: [
      { name: "sessions", orderBy: ["id"] },
      { name: "messages", orderBy: ["id"] },
    ],
    ...(projection === "include" ? {} : { projection }),
  };
}

function capture(sqliteProjection = "include") {
  return {
    tree: { enabled: false, root: "home", exclude: [] },
    sqlite: [dbCapture(sqliteProjection)],
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
}

function normalizations(rows = 2, includeSqlite = true, includeTodayInSqlite = true) {
  const result = [
    {
      field: "process.stdout",
      kind: "replace-json-pointer",
      pointer: "/session_id",
      replacement: "<SESSION_ID>",
    },
    {
      field: "process.stderr",
      kind: "replace-regex",
      pattern: "(?<=session: )[0-9a-f]{32}(?=  \\(resume with --session )",
      replacement: "<SESSION_ID>",
    },
    {
      field: "process.stderr",
      kind: "replace-regex",
      pattern: "(?<=--session )[0-9a-f]{32}(?=\\))",
      replacement: "<SESSION_ID>",
    },
    {
      field: "events.requests",
      kind: "replace-runtime-path",
      source: "profile",
      replacement: "<PROJECT>",
    },
    // Cross-cutting fixup: the system prompt's "Today's date is
    // YYYY-MM-DD." otherwise sits inside the hashed projection unnormalized
    // — a digest that's meant to prove no-regression then breaks on its
    // own every UTC midnight, with or without any real divergence. Every
    // T08 scenario's captured request carries it at least once.
    // hashOnly: true is load-bearing — unlike every other rule here, the
    // date is supposed to be IDENTICAL between oracle and candidate; a
    // mismatch is the bug this exists to catch, so it must still be
    // compared BEFORE normalization, only stabilized after (round-1
    // Evaluator finding: the non-hashOnly version silently absorbed a
    // real oracle/candidate date divergence into "match").
    {
      field: "events.requests",
      kind: "replace-regex",
      pattern: "Today's date is \\d{4}-\\d{2}-\\d{2}\\.",
      replacement: "Today's date is <DATE>.",
      hashOnly: true,
    },
  ];
  if (!includeSqlite) return result;
  result.push(
    {
      field: "sqlite.db",
      kind: "replace-runtime-path",
      source: "profile",
      replacement: "<PROJECT>",
    },
    {
      field: "sqlite.db",
      kind: "replace-json-pointer",
      pointer: "/schema/17/sql",
      replacement: "<WORKFLOW_AUDIT_EVENTS_SCHEMA>",
    },
    {
      field: "sqlite.db",
      kind: "replace-json-pointer",
      pointer: "/tables/sessions/rows/0/0",
      replacement: "<SESSION_ID>",
    },
    {
      field: "sqlite.db",
      kind: "replace-json-pointer",
      pointer: "/tables/sessions/rows/0/7",
      replacement: "<TIMESTAMP>",
    },
  );
  // Same rationale as the events.requests rule above — the stored system
  // message row in sqlite also embeds today's date, EXCEPT for the one
  // scenario whose entire premise is that the prompt is NOT stored
  // (mutant-prompt-not-stored): the oracle's sqlite.db has it, the
  // candidate's deliberately doesn't, so requiring a match on both sides
  // would fail the very divergence this scenario exists to prove.
  if (includeTodayInSqlite) {
    result.push({
      field: "sqlite.db",
      kind: "replace-regex",
      pattern: "Today's date is \\d{4}-\\d{2}-\\d{2}\\.",
      replacement: "Today's date is <DATE>.",
      hashOnly: true,
    });
  }
  for (let index = 0; index < rows; index += 1) {
    result.push(
      {
        field: "sqlite.db",
        kind: "replace-json-pointer",
        pointer: `/tables/messages/rows/${index}/1`,
        replacement: "<SESSION_ID>",
      },
      {
        field: "sqlite.db",
        kind: "replace-json-pointer",
        pointer: `/tables/messages/rows/${index}/7`,
        replacement: "<TIMESTAMP>",
      },
    );
  }
  return result;
}

const definitions = [
  { id: "chat-success-ascii", fixture: "chat-text", input: "hello", exit: 0, posts: 1, rows: 2 },
  {
    id: "chat-success-unicode",
    fixture: "chat-text",
    input: `olá 😀 "quoted" back\\slash ${String.fromCharCode(0x7f)}`,
    exit: 0,
    posts: 1,
    rows: 2,
  },
  { id: "chat-no-usage", fixture: "chat-no-usage", input: "no usage", exit: 0, posts: 1, rows: 2 },
  {
    id: "chat-pricing-override",
    fixture: "chat-text",
    input: "priced",
    exit: 0,
    posts: 1,
    rows: 2,
    pricing: true,
  },
  {
    id: "chat-error-401",
    fixture: "chat-http-401",
    input: "unauthorized",
    exit: 1,
    posts: 1,
    rows: 0,
  },
  {
    id: "chat-error-500",
    fixture: "chat-http-500",
    input: "server error",
    exit: 1,
    posts: 3,
    rows: 0,
  },
  {
    id: "chat-resume-two-turns",
    fixture: "chat-text",
    input: "first",
    nextInput: "second",
    mode: "resume",
    exit: 0,
    posts: 2,
    rows: 4,
  },
  {
    id: "chat-no-tools-prompt",
    fixture: "chat-text",
    input: "prompt",
    exit: 0,
    posts: 1,
    rows: 2,
    canaries: true,
  },
  {
    id: "chat-incomplete-tool-call",
    fixture: "chat-incomplete-tool",
    input: "incomplete",
    exit: 1,
    posts: 1,
    rows: 0,
  },
  {
    id: "chat-max-iterations-characterization",
    fixture: "chat-text",
    input: "bounded",
    exit: 0,
    posts: 1,
    rows: 2,
    extra: ["--max-iterations", "0"],
  },
  {
    id: "chat-complete-tool-hardening",
    fixture: "chat-tool",
    input: "tool",
    exit: 1,
    oracleExit: 0,
    posts: 1,
    rows: 0,
    expectedDivergent: true,
  },
  {
    id: "chat-unknown-tool-hardening",
    fixture: "chat-tool-unknown",
    input: "unknown",
    exit: 1,
    oracleExit: 0,
    posts: 1,
    rows: 0,
    expectedDivergent: true,
  },
  {
    id: "mutant-json-stringify",
    fixture: "chat-text",
    input: "float",
    exit: 0,
    posts: 1,
    rows: 2,
    mutant: "json-stringify",
    expectedDivergent: true,
  },
  {
    id: "mutant-session-on-error",
    fixture: "chat-http-401",
    input: "error",
    exit: 1,
    posts: 1,
    rows: 0,
    mutant: "session-on-error",
    expectedDivergent: true,
  },
  {
    id: "mutant-usage-zero-fields",
    fixture: "chat-text",
    input: "zeros",
    exit: 0,
    posts: 1,
    rows: 2,
    mutant: "usage-zero-fields",
    expectedDivergent: true,
  },
  {
    id: "mutant-error-persists-message",
    fixture: "chat-http-401",
    input: "error db",
    exit: 1,
    posts: 1,
    rows: 0,
    mutant: "error-persists-message",
    expectedDivergent: true,
  },
  {
    id: "mutant-resume-cumulative-turn-usage",
    fixture: "chat-text",
    input: "first",
    nextInput: "second",
    mode: "resume",
    exit: 0,
    posts: 2,
    rows: 4,
    mutant: "resume-cumulative",
    expectedDivergent: true,
  },
  {
    id: "mutant-prompt-not-stored",
    fixture: "chat-text",
    input: "prompt db",
    exit: 0,
    posts: 1,
    rows: 2,
    mutant: "prompt-not-stored",
    expectedDivergent: true,
  },
];

for (const definition of definitions) {
  const argv = [
    "chat",
    definition.input,
    "--json",
    "--no-tools",
    "--provider",
    "ollama",
    "--model",
    "stub-coder:1b",
    ...(definition.extra ?? []),
  ];
  if (definition.nextInput !== undefined) argv.push("--next-input", definition.nextInput);
  const fixtures = [];
  if (definition.pricing)
    fixtures.push({
      root: "home",
      path: ".lohra/pricing.json",
      encoding: "utf8",
      content: '{"ollama":{"stub-coder:1b":{"input_usd":0.5,"output_usd":0.25}}}',
    });
  if (definition.canaries)
    fixtures.push(
      { root: "home", path: ".lohra/MEMORY.md", encoding: "utf8", content: "T08-MEMORY-CANARY" },
      { root: "home", path: ".lohra/USER.md", encoding: "utf8", content: "T08-USER-CANARY" },
      {
        root: "profile",
        path: ".claude/skills/canary/SKILL.md",
        encoding: "utf8",
        content: "T08-SKILL-CANARY",
      },
    );
  const comparisons = [
    { class: "byte", field: "process.exitCode" },
    { class: "byte", field: "process.signal" },
    { class: "byte", field: "process.stdout" },
    { class: "byte", field: "process.stderr" },
    { class: "stub", field: "events.requests" },
    { class: "stub", field: "events.summary" },
    { class: "stub", field: "events.assertions" },
  ];
  if (!definition.id.includes("tool-hardening"))
    comparisons.push({ class: "schema", field: "sqlite.db" });
  const expectations = [
    { side: "oracle", field: "process.exitCode", value: definition.oracleExit ?? definition.exit },
    { side: "candidate", field: "process.exitCode", value: definition.exit },
    { side: "both", field: "process.signal", value: null },
    {
      side: "both",
      field: "events.summary",
      value: {
        exists: true,
        records: {
          gets: 0,
          posts: definition.posts,
          sequence: Array.from({ length: definition.posts }, () => "POST /v1/chat/completions"),
        },
      },
    },
    {
      side: "both",
      field: "events.assertions",
      value: { exists: true, records: { valid: true, failures: [] } },
    },
  ];
  if (!definition.expectedDivergent && definition.exit === 0)
    expectations.push({
      side: "both",
      field: "process.stdout",
      encoding: "utf8",
      pointer: "/completed",
      value: true,
    });
  if (definition.id === "chat-no-usage")
    expectations.push({
      side: "both",
      field: "process.stdout",
      encoding: "utf8",
      pointer: "/usage",
      value: null,
    });
  if (definition.id === "chat-incomplete-tool-call")
    expectations.push(
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/completed",
        value: false,
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/stop_reason",
        value: null,
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/usage",
        value: { input_tokens: 11, output_tokens: 7 },
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/usage_total",
        value: { input_tokens: 11, output_tokens: 7 },
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/session/api_call_count",
        value: 1,
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/session/priced_call_count",
        value: 1,
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/10",
        value: { decimal: "0", type: "integer" },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/12",
        value: { decimal: "11", type: "integer" },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/13",
        value: { decimal: "7", type: "integer" },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/18",
        value: { type: "real", value: 0 },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/19",
        value: { type: "real", value: 0 },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/21",
        value: { decimal: "1", type: "integer" },
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/23",
        value: { decimal: "1", type: "integer" },
      },
      { side: "both", field: "sqlite.db", pointer: "/tables/messages/rows", value: [] },
    );
  if (definition.id.includes("tool-hardening"))
    expectations.push(
      {
        side: "oracle",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/completed",
        value: true,
      },
      {
        side: "candidate",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/error",
        value: "provider returned tool_calls while tools are disabled",
      },
      {
        side: "candidate",
        field: "sqlite.db",
        pointer: "/tables/messages/rows",
        value: [],
      },
      {
        side: "candidate",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/10",
        value: { decimal: "0", type: "integer" },
      },
      {
        side: "candidate",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/21",
        value: { decimal: "0", type: "integer" },
      },
    );
  const manifest = {
    schemaVersion: 1,
    id: `t08-${definition.id}`,
    description: `T08 public conversation runtime: ${definition.id}`,
    argv,
    environment,
    preconditions: [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }],
    fixtures,
    runners: runners(definition.mode ?? "single", definition.mutant),
    limits: { timeoutMs: 60_000, maxOutputBytes: 16_777_216 },
    capture: capture(definition.id.includes("tool-hardening") ? "raw-only" : "include"),
    comparisons,
    expectations,
    normalizations: normalizations(
      definition.rows,
      !definition.id.includes("tool-hardening"),
      definition.id !== "mutant-prompt-not-stored",
    ),
    stub: {
      state: "up-with-models",
      fixture: definition.fixture,
      requestLog: { comparedHeaders, excludedHeaders },
    },
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: guard,
  };
  writeFileSync(
    resolve(scenarios, `${manifest.id}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
