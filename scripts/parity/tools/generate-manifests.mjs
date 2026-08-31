#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve("scripts/parity/manifests/t09");
mkdirSync(directory, { recursive: true });

const match = [
  "registry-generation-availability",
  "registry-shadowing-schema",
  "registry-dispatch-errors",
  "dispatch-malformed-arguments",
  "dispatch-parallel-order",
  "tool-envelope-python-json",
  "approval-pattern-order",
  "approval-decisions",
  "read-file-boundaries",
  "write-file-boundaries",
  "terminal-boundaries",
  "memory-handler",
  "skills-handler",
  "session-search-handler",
  "list-models-zero-egress",
  "failsafe-handler-catalog",
  "lifecycle-wrapper",
];
const divergent = [
  "child-unknown-hardening",
  "child-terminal-type-hardening",
  "mutant-json-stringify",
  "mutant-utf16-truncation",
  "mutant-ttl-inclusive",
  "mutant-gate-after-exec",
  "mutant-resume-stored-prompt",
];
const guard = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
  expectedPythonVersion: "3.12.10",
  expectedPackages: { openai: "3.6.0", httpx: "0.28.1" },
};

for (const name of [...match, ...divergent]) {
  const id = `t09-${name}`;
  const manifest = {
    schemaVersion: 1,
    id,
    description: `T09 bilateral direct observation: ${name}`,
    argv: [name],
    environment: {
      allow: [],
      set: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONUTF8: "1",
        NO_COLOR: "1",
        HOME: "{{home}}",
        TMPDIR: "{{home}}/tmp",
      },
    },
    preconditions: [],
    fixtures: [],
    runners: {
      oracle: {
        adapter: "python",
        executable: "oracle-python",
        prefixArgs: ["{{projectRoot}}/scripts/parity/tools/oracle_driver.py"],
        cwd: "profile",
      },
      candidate: {
        adapter: "typescript",
        executable: "node",
        prefixArgs: ["{{projectRoot}}/scripts/parity/tools/candidate-driver.mjs"],
        cwd: "profile",
      },
    },
    limits: { timeoutMs: name === "terminal-boundaries" ? 30000 : 10000, maxOutputBytes: 16777216 },
    capture: { tree: { enabled: false, root: "profile", exclude: [] }, sqlite: [], events: [] },
    comparisons: [
      { class: "byte", field: "process.exitCode" },
      { class: "byte", field: "process.signal" },
      { class: "byte", field: "process.stdout" },
      { class: "byte", field: "process.stderr" },
    ],
    expectations: [
      { side: "both", field: "process.exitCode", value: 0 },
      { side: "both", field: "process.signal", value: null },
    ],
    normalizations: [],
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: guard,
  };
  writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

const treeScenarios = new Set([
  "t09-public-write-file-effect",
  "t09-public-terminal-safe",
  "t09-public-terminal-denied",
  "t09-public-terminal-yolo",
  "t09-public-memory-mutate",
  "t09-public-skill-mutate",
]);
for (const filename of readdirSync(directory).filter(
  (name) => name.startsWith("t09-public-") && name.endsWith(".json"),
)) {
  const path = join(directory, filename);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.stub?.toolSequence) {
    manifest.stub.toolSequence = manifest.stub.toolSequence.map((step) =>
      Array.isArray(step.calls) ? step : { calls: [step] },
    );
  }
  if (manifest.id === "t09-public-terminal-safe") {
    manifest.stub.toolSequence[0].calls = [
      {
        name: "terminal",
        argumentsRaw:
          '{"command":"sleep 0.05; printf terminal > terminal-sentinel; printf out; printf err >&2; exit 7"}',
        expectedResult: '{"ok": true, "stdout": "out", "stderr": "err", "exit_code": 7}',
        validation: "exact",
      },
      {
        name: "write_file",
        argumentsRaw: '{"path":"parallel-sentinel.txt","content":"second"}',
        expectedResult: '{"ok": true, "bytes_written": 6, "path": "parallel-sentinel.txt"}',
        validation: "exact",
      },
    ];
  }
  const exit = manifest.expectations.find((item) => item.field === "process.exitCode") ?? {
    side: "both",
    field: "process.exitCode",
    value: 0,
  };
  const assertions = manifest.expectations.find((item) => item.field === "events.assertions");
  if (!assertions) throw new Error(`${manifest.id} lacks mandatory public stub assertion`);
  const postCount =
    manifest.id === "t09-public-no-tools-control" ||
    manifest.id === "t09-public-memory-skills-prompt" ||
    manifest.id === "t09-public-max-iterations"
      ? 1
      : manifest.id === "t09-public-resume-rerender"
        ? 3
        : 2;
  manifest.expectations = [
    exit,
    { side: "both", field: "process.signal", value: null },
    {
      side: "both",
      field: "events.summary",
      value: {
        exists: true,
        records: {
          gets: 0,
          posts: postCount,
          sequence: Array.from({ length: postCount }, () => "POST /v1/chat/completions"),
        },
      },
    },
    assertions,
  ];
  if (manifest.id === "t09-public-max-iterations") {
    manifest.expectations.push(
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/completed",
        value: false,
      },
      { side: "both", field: "process.stdout", encoding: "utf8", pointer: "/api_calls", value: 1 },
      { side: "both", field: "process.stdout", encoding: "utf8", pointer: "/output", value: null },
    );
  } else {
    manifest.expectations.push(
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/completed",
        value: true,
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/api_calls",
        value: manifest.id === "t09-public-resume-rerender" ? 1 : postCount,
      },
    );
  }
  const messageCount =
    manifest.id === "t09-public-max-iterations"
      ? 0
      : manifest.id === "t09-public-no-tools-control" ||
          manifest.id === "t09-public-memory-skills-prompt"
        ? 2
        : manifest.id === "t09-public-resume-rerender"
          ? 6
          : manifest.id === "t09-public-terminal-safe"
            ? 5
            : 4;
  manifest.capture.sqlite = [
    {
      name: "db",
      root: "home",
      path: ".lohra/profiles/p/state.db",
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
    },
  ];
  if (!manifest.comparisons.some((item) => item.field === "sqlite.db"))
    manifest.comparisons.push({ class: "schema", field: "sqlite.db" });
  manifest.normalizations = manifest.normalizations.filter(
    (item) => item.field !== "sqlite.db" && item.field !== "events.requests",
  );
  manifest.normalizations.push(
    {
      field: "sqlite.db",
      kind: "replace-runtime-path",
      source: "profile",
      replacement: "<PROFILE>",
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
    // Cross-cutting fixup: the system prompt's "Today's date is
    // YYYY-MM-DD." otherwise sits inside these two hashed fields
    // unnormalized — a digest that's meant to prove no-regression then
    // breaks on its own every UTC/local midnight, with or without any
    // real divergence. All 14 t09-public-* scenarios carry it in both
    // events.requests and sqlite.db (measured, not assumed).
    {
      field: "sqlite.db",
      kind: "replace-regex",
      pattern: "Today's date is \\d{4}-\\d{2}-\\d{2}\\.",
      replacement: "Today's date is <DATE>.",
    },
    {
      field: "events.requests",
      kind: "replace-runtime-path",
      source: "profile",
      replacement: "<PROFILE>",
    },
    {
      field: "events.requests",
      kind: "replace-regex",
      pattern: "Today's date is \\d{4}-\\d{2}-\\d{2}\\.",
      replacement: "Today's date is <DATE>.",
    },
  );
  for (let index = 0; index < messageCount; index += 1) {
    manifest.normalizations.push(
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
  if (
    manifest.id === "t09-public-read-file-anchor" ||
    manifest.id === "t09-public-max-iterations"
  ) {
    const anchor = manifest.id === "t09-public-read-file-anchor";
    const integer = (decimal) => ({ type: "integer", decimal: String(decimal) });
    manifest.expectations.push(
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/messages/rows",
        value: anchor ? undefined : [],
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/10",
        value: integer(anchor ? 4 : 0),
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/11",
        value: integer(0),
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/12",
        value: integer(anchor ? 22 : 11),
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/13",
        value: integer(anchor ? 14 : 7),
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/21",
        value: integer(anchor ? 2 : 1),
      },
      {
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/sessions/rows/0/23",
        value: integer(anchor ? 2 : 1),
      },
    );
    if (anchor) {
      manifest.expectations = manifest.expectations.filter((item) => item.value !== undefined);
      manifest.expectations.push({
        side: "both",
        field: "sqlite.db",
        pointer: "/tables/messages/rows/2/3",
        value:
          '{"ok": true, "data": "STUB-TOOL-EVIDENCE v1\\n", "truncated": false, "path": "tool-target.txt"}',
      });
    }
  }
  if (treeScenarios.has(manifest.id)) {
    manifest.capture.tree = {
      enabled: true,
      root: manifest.id.includes("memory") || manifest.id.includes("skill") ? "home" : "profile",
      exclude:
        manifest.id.includes("memory") || manifest.id.includes("skill")
          ? [
              ".lohra/profiles/p/state.db",
              ".lohra/profiles/p/state.db-shm",
              ".lohra/profiles/p/state.db-wal",
              "tmp",
              ".lohra/profiles/p/cron",
              ".lohra/profiles/p/logs",
              ".lohra/profiles/p/plugins",
              ...(manifest.id.includes("memory")
                ? [".lohra/profiles/p/skills"]
                : [".lohra/profiles/p/memories"]),
            ]
          : [
              "stub-requests.jsonl",
              "stub-requests-raw.jsonl",
              "stub-summary.json",
              "stub-assertions.json",
            ],
    };
    if (!manifest.comparisons.some((item) => item.field === "tree"))
      manifest.comparisons.push({ class: "schema", field: "tree" });
    const trees = {
      "t09-public-write-file-effect": [
        { path: "written", type: "directory" },
        {
          mode: "0644",
          path: "written/out.txt",
          sha256: "043764df773ac7ceea6175e1498893e6ee33e79885288417cc1d75cba6094827",
          size: 10,
          type: "file",
        },
      ],
      "t09-public-terminal-safe": [
        {
          mode: "0644",
          path: "parallel-sentinel.txt",
          sha256: "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
          size: 6,
          type: "file",
        },
        {
          mode: "0644",
          path: "terminal-sentinel",
          sha256: "4e686af7bdcc5ae005a247624fd8c7283257c2514f6b3ad2ff5d4cb6d95196e6",
          size: 8,
          type: "file",
        },
      ],
      "t09-public-terminal-denied": [],
      "t09-public-terminal-yolo": [],
      "t09-public-memory-mutate": [
        { path: ".lohra", type: "directory" },
        { path: ".lohra/profiles", type: "directory" },
        { path: ".lohra/profiles/p", type: "directory" },
        { path: ".lohra/profiles/p/memories", type: "directory" },
        {
          mode: "0644",
          path: ".lohra/profiles/p/memories/MEMORY.md",
          sha256: "e54c253c5eb1e7dd72f7c9bc1965a49c7a2cc655e8f413268af8513db6831f2b",
          size: 13,
          type: "file",
        },
      ],
      "t09-public-skill-mutate": [
        { path: ".lohra", type: "directory" },
        { path: ".lohra/profiles", type: "directory" },
        { path: ".lohra/profiles/p", type: "directory" },
        { path: ".lohra/profiles/p/skills", type: "directory" },
        { path: ".lohra/profiles/p/skills/canary-skill", type: "directory" },
        {
          mode: "0644",
          path: ".lohra/profiles/p/skills/canary-skill/SKILL.md",
          sha256: "6f393151b9b22cb5a844574187f06ae0418cf6649c11df77a433e9146041e75c",
          size: 63,
          type: "file",
        },
      ],
    };
    manifest.expectations.push({ side: "both", field: "tree", value: trees[manifest.id] });
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
