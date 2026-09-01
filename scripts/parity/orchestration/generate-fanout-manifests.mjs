#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const outputDirectory = resolve("scripts/parity/manifests/t13");
mkdirSync(outputDirectory, { recursive: true });

const oracleGuard = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
  expectedPythonVersion: "3.12.10",
  expectedPackages: { openai: "3.6.0", httpx: "0.28.1" },
};

const requestLog = {
  comparedHeaders: ["authorization", "accept", "content-type", "host", "x-stainless-retry-count"],
  excludedHeaders: [
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
  ],
};

const runners = {
  oracle: {
    adapter: "python",
    executable: "oracle-python",
    prefixArgs: ["{{projectRoot}}/scripts/parity/conversation/oracle_driver.py", "single"],
    cwd: "profile",
  },
  candidate: {
    adapter: "typescript",
    executable: "node",
    prefixArgs: ["{{projectRoot}}/scripts/parity/conversation/candidate-driver.mjs", "single"],
    cwd: "profile",
  },
};

const baseEnvironment = {
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
};

const comparisons = [
  { class: "byte", field: "process.exitCode" },
  { class: "byte", field: "process.signal" },
  { class: "byte", field: "process.stdout" },
  { class: "byte", field: "process.stderr" },
  { class: "stub", field: "events.summary" },
  { class: "stub", field: "events.assertions" },
];

const normalizations = [
  {
    field: "process.stdout",
    kind: "replace-json-pointer",
    pointer: "/session_id",
    replacement: "<SESSION_ID>",
  },
  {
    field: "process.stdout",
    kind: "replace-regex",
    pattern: "[0-9a-f]{32}",
    replacement: "<SUB_ID>",
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
];

const matrix = [
  { id: "t13-fanout-default-four", expected: 4, argv: [], env: {}, label: "default -> 4" },
  {
    id: "t13-fanout-flag-one",
    expected: 1,
    argv: ["--max-parallel", "1"],
    env: {},
    label: "flag 1 -> 1",
  },
  {
    id: "t13-fanout-flag-two",
    expected: 2,
    argv: ["--max-parallel", "2"],
    env: {},
    label: "flag 2 -> 2",
  },
  {
    id: "t13-fanout-flag-zero-clamps-one",
    expected: 1,
    argv: ["--max-parallel", "0"],
    env: {},
    label: "flag 0 clamps to 1",
  },
  {
    id: "t13-fanout-flag-negative-clamps-one",
    expected: 1,
    argv: ["--max-parallel", "-5"],
    env: {},
    label: "flag -5 clamps to 1",
  },
  {
    id: "t13-fanout-env-two",
    expected: 2,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "2" },
    label: "env 2 -> 2",
  },
  {
    id: "t13-fanout-env-zero-falls-back-four",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "0" },
    label: "env 0 falls back to 4",
  },
  {
    id: "t13-fanout-env-negative-falls-back-four",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "-5" },
    label: "env -5 falls back to 4",
  },
  {
    id: "t13-fanout-clamp-not-an-integer-warning",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "abc" },
    label: "env abc falls back to 4",
  },
  {
    id: "t13-fanout-env-empty-falls-back-four-silent",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "" },
    label: "empty env silently falls back to 4",
  },
  {
    id: "t13-fanout-env-float-falls-back-four",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "3.0" },
    label: "env 3.0 falls back to 4",
  },
  {
    id: "t13-fanout-precedence-flag-three-over-env-one",
    expected: 3,
    argv: ["--max-parallel", "3"],
    env: { LOHRA_MAX_PARALLEL: "1" },
    label: "flag 3 beats env 1",
  },
  {
    id: "t13-fanout-precedence-flag-one-over-env-five",
    expected: 1,
    argv: ["--max-parallel", "1"],
    env: { LOHRA_MAX_PARALLEL: "5" },
    label: "flag 1 beats env 5",
  },
  {
    id: "t13-fanout-env-padded-two",
    expected: 2,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: " 2 " },
    label: "padded env integer parses as 2",
  },
  {
    id: "t13-fanout-env-plus-two",
    expected: 2,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "+2" },
    label: "signed env integer parses as 2",
  },
  {
    id: "t13-fanout-env-underscore-ten",
    expected: 10,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "1_0" },
    label: "PEP 515 underscore env integer parses as 10",
  },
  {
    id: "t13-fanout-env-repr-apostrophe-backslash",
    expected: 4,
    argv: [],
    env: { LOHRA_MAX_PARALLEL: "a'b\\c" },
    label: "repr escapes apostrophe and backslash before falling back to 4",
  },
];

function capture() {
  return {
    tree: { enabled: false, root: "home", exclude: [] },
    sqlite: [],
    events: [
      { name: "requests", root: "profile", path: "stub-requests.jsonl", format: "jsonl" },
      { name: "summary", root: "profile", path: "stub-summary.json", format: "json" },
      { name: "assertions", root: "profile", path: "stub-assertions.json", format: "json" },
    ],
  };
}

function successManifest(config) {
  const parent = [];
  const laneSteps = {};
  for (let index = 1; index <= config.expected + 1; index += 1) {
    const step = {
      kind: "tool_calls",
      calls: [
        {
          name: "spawn_session",
          argumentsRaw: JSON.stringify({ prompt: `SCEN:kid${index} do it` }),
        },
      ],
    };
    if (index > 1) step.awaitSignal = `kid${index - 1}-arrived`;
    parent.push(step);
    if (index <= config.expected) {
      laneSteps[`kid${index}`] = [
        {
          kind: "text",
          content: `KID${index}-DONE`,
          signal: `kid${index}-arrived`,
          gate: "release-blockers",
        },
      ];
    } else {
      laneSteps[`kid${index}`] = [{ kind: "text", content: `KID${index}-DONE` }];
    }
  }
  const queuedIndex = config.expected + 1;
  const reminder = `queued-at-${config.expected}`;
  parent.push({
    kind: "tool_calls",
    calls: [
      {
        name: "steer_session",
        argumentsRaw: JSON.stringify({ sub_id: `__SUB${queuedIndex}__`, text: reminder }),
      },
    ],
  });
  parent.push({
    kind: "tool_calls",
    openGate: "release-blockers",
    calls: Array.from({ length: queuedIndex }, (_, offset) => ({
      name: "collect_session",
      argumentsRaw: JSON.stringify({ sub_id: `__SUB${offset + 1}__`, wait: true }),
    })),
  });
  parent.push({ kind: "text", content: "PARENT-DONE" });
  laneSteps.parent = parent;

  const posts = 2 * config.expected + 5;
  const queuedRequestIndex = 2 * config.expected + 3;
  const allow = Object.hasOwn(config.env, "LOHRA_MAX_PARALLEL") ? ["LOHRA_MAX_PARALLEL"] : [];
  const wideMatrixCase = config.expected > 4;
  const wideCaseNote = wideMatrixCase
    ? " KNOWN HARNESS LIMIT: process.stdout is not a bilateral comparison for this width-10 row because its nested tool-call strings contain more than the harness's fail-closed ceiling of 16 dynamic sub_id matches. The exact width remains bilateral and machine-enforced by the lower-bound arrival chain plus the upper-bound queued-child reminder expectation on both sides, events.summary, exit code, stderr, and assertions."
    : "";
  return {
    schemaVersion: 1,
    id: config.id,
    description: `T13 round-2 bilateral fan-out matrix (${config.label}), closing contract assertion 24/F4. This is a deterministic exact-concurrency proof, not a startup-warning proxy: ${config.expected} blocker children are spawned one at a time, and each next spawn is withheld by the harness until the previous child has reached its gated first request. Child ${queuedIndex} is then spawned and steered while the first ${config.expected} slots are occupied. If effective concurrency is below ${config.expected}, the next blocker never arrives and the scenario times out; if it is above ${config.expected}, child ${queuedIndex} starts before steer and its first request lacks the asserted system-reminder. Only exactly ${config.expected} satisfies both halves. No sleep, ambient credentials, or external egress.${wideCaseNote}`,
    argv: [
      "chat",
      `SCEN:parent ${config.id}`,
      "--json",
      "--provider",
      "ollama",
      "--model",
      "stub-coder:1b",
      ...config.argv,
    ],
    environment: { allow, set: { ...baseEnvironment, ...config.env } },
    preconditions: [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }],
    fixtures: [],
    runners,
    limits: { timeoutMs: 60000, maxOutputBytes: 16777216 },
    capture: capture(),
    comparisons: wideMatrixCase
      ? comparisons.filter((entry) => entry.field !== "process.stdout")
      : comparisons,
    expectations: [
      { side: "both", field: "process.exitCode", value: 0 },
      { side: "both", field: "process.signal", value: null },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/completed",
        value: true,
      },
      {
        side: "both",
        field: "events.assertions",
        value: { exists: true, records: { valid: true, failures: [] } },
      },
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
        field: "events.requests",
        pointer: `/records/${queuedRequestIndex}/body/messages/2`,
        value: { role: "user", content: `<system-reminder>\n${reminder}\n</system-reminder>` },
      },
    ],
    normalizations: wideMatrixCase
      ? normalizations.filter((entry) => entry.field !== "process.stdout")
      : normalizations,
    stub: {
      state: "up-with-models",
      fixture: "chat-lane-script",
      requestLog,
      laneSteps,
    },
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard,
  };
}

function invalidFlagManifest() {
  return {
    schemaVersion: 1,
    id: "t13-fanout-flag-noninteger-usage",
    description:
      "T13 round-2 bilateral CLI proof for Evaluator obligation F4(a): --max-parallel 2.9 is rejected by argument parsing with exit 2 and a usage message before the upstream receives any request. process.stderr is compared byte-for-byte, and the aggregate T13 runner separately asserts the decoded stderr starts with 'usage:' so an equal-but-wrong empty error cannot pass. The isolated harness supplies empty HOME/CODEX_HOME and the local stub; no ambient credential or external egress is reachable.",
    argv: [
      "chat",
      "SCEN:parent invalid flag",
      "--json",
      "--provider",
      "ollama",
      "--model",
      "stub-coder:1b",
      "--max-parallel",
      "2.9",
    ],
    environment: { allow: [], set: baseEnvironment },
    preconditions: [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }],
    fixtures: [],
    runners,
    limits: { timeoutMs: 20000, maxOutputBytes: 16777216 },
    capture: {
      tree: { enabled: false, root: "home", exclude: [] },
      sqlite: [],
      events: [
        { name: "summary", root: "profile", path: "stub-summary.json", format: "json" },
        { name: "assertions", root: "profile", path: "stub-assertions.json", format: "json" },
      ],
    },
    comparisons,
    expectations: [
      { side: "both", field: "process.exitCode", value: 2 },
      { side: "both", field: "process.signal", value: null },
      { side: "both", field: "process.stdout", encoding: "utf8", value: "" },
      {
        side: "both",
        field: "events.assertions",
        value: { exists: true, records: { valid: true, failures: [] } },
      },
      {
        side: "both",
        field: "events.summary",
        value: { exists: true, records: { gets: 0, posts: 0, sequence: [] } },
      },
    ],
    normalizations: [],
    stub: {
      state: "up-with-models",
      fixture: "chat-lane-script",
      requestLog,
      laneSteps: { parent: [{ kind: "text", content: "UNREACHABLE" }] },
    },
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard,
  };
}

for (const config of matrix) {
  writeFileSync(
    resolve(outputDirectory, `${config.id}.json`),
    `${JSON.stringify(successManifest(config), null, 2)}\n`,
  );
}
const invalid = invalidFlagManifest();
writeFileSync(
  resolve(outputDirectory, `${invalid.id}.json`),
  `${JSON.stringify(invalid, null, 2)}\n`,
);

process.stdout.write(`${JSON.stringify({ generated: matrix.length + 1, outputDirectory })}\n`);
