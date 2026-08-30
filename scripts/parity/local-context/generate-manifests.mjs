#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const destination = resolve("scripts/parity/scenarios");
mkdirSync(destination, { recursive: true });

const guard = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
  expectedPythonVersion: "3.12.10",
};
const environment = (extra = {}) => ({
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
    LOHRA_HOME: "{{profile}}",
    ...extra,
  },
});
const capture = (tree = false, root = "profile") => ({
  tree: { enabled: tree, root, exclude: [] },
  sqlite: [],
  events: [],
});
const processComparisons = (stdout = true, tree = false) => [
  { class: "byte", field: "process.exitCode" },
  { class: "byte", field: "process.signal" },
  ...(stdout ? [{ class: "probe", field: "process.stdout" }] : []),
  { class: "byte", field: "process.stderr" },
  ...(tree ? [{ class: "schema", field: "tree" }] : []),
];
const baseExpectations = [
  { side: "both", field: "process.exitCode", value: 0 },
  { side: "both", field: "process.signal", value: null },
  { side: "both", field: "process.stderr", encoding: "utf8", value: "" },
];
const pointer = (pointer, value, side = "both") => ({
  side,
  field: "process.stdout",
  encoding: "utf8",
  pointer,
  value,
});
const normalize = (source) => ({
  field: "process.stdout",
  kind: "replace-runtime-path",
  source,
  replacement: `<${source.toUpperCase()}>`,
});
const directRunners = (oracleMode, candidateMode = oracleMode) => ({
  oracle: {
    adapter: "python",
    executable: "oracle-python",
    prefixArgs: ["{{projectRoot}}/scripts/parity/local-context/oracle_driver.py", oracleMode],
    cwd: "sandbox",
  },
  candidate: {
    adapter: "typescript",
    executable: "node",
    prefixArgs: [
      "{{projectRoot}}/scripts/parity/local-context/candidate-driver.mjs",
      candidateMode,
    ],
    cwd: "sandbox",
  },
});
const cliRunners = {
  oracle: { adapter: "python", executable: "oracle-lohra", prefixArgs: [], cwd: "sandbox" },
  candidate: {
    adapter: "typescript",
    executable: "node",
    prefixArgs: ["{{projectRoot}}/dist/cli.js"],
    cwd: "sandbox",
  },
};

function manifest({
  id,
  argv = [],
  runners,
  fixtures = [],
  extraEnvironment = {},
  preconditions = [],
  tree = false,
  treeRoot = "profile",
  stdout = true,
  expectations = [],
  normalizations = [],
  expectedExit = 0,
}) {
  const value = {
    schemaVersion: 1,
    id,
    description: `T06 local context/onboarding: ${id}`,
    argv,
    environment: environment(extraEnvironment),
    preconditions,
    fixtures,
    runners,
    limits: { timeoutMs: 15000, maxOutputBytes: 4194304 },
    capture: capture(tree, treeRoot),
    comparisons: processComparisons(stdout, tree),
    expectations: [
      ...baseExpectations.map((expectation) =>
        expectation.field === "process.exitCode"
          ? { ...expectation, value: expectedExit }
          : expectation,
      ),
      ...expectations,
    ],
    normalizations,
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: guard,
  };
  writeFileSync(resolve(destination, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

const direct = [
  ["t06-memory-core", "memory-core", [pointer("/boundary", true), pointer("/unchanged", true)]],
  [
    "t06-memory-write-discipline",
    "memory-write-discipline",
    [pointer("/mode", "0666"), pointer("/temps", [])],
    true,
  ],
  [
    "t06-snapshot-freeze",
    "snapshot-freeze",
    [pointer("/frozen/memory", "first"), pointer("/fresh/memory", "first\n§\nsecond")],
  ],
  [
    "t06-prompt-snapshot",
    "prompt-snapshot",
    [pointer("/stable", "SOUL\n\nEnvironment:\n- cwd: /project/sub\n- project_root: /project")],
  ],
  [
    "t06-soul",
    "soul",
    [pointer("/values/0", null), pointer("/values/1", "persona"), pointer("/directoryError", true)],
  ],
  [
    "t06-project-discovery",
    "project-discovery",
    [pointer("/instructions/0/1", "near agents")],
    false,
    [normalize("home")],
  ],
  [
    "t06-project-bounds",
    "project-bounds",
    [
      pointer("/farIsLeaf", true),
      pointer("/nearFound", true),
      pointer("/nonexistent/keys", ["cwd", "project_root"]),
      pointer("/nonexistent/cwdResolved", true),
      pointer("/caught/keys", ["cwd"]),
      pointer("/caught/received", true),
    ],
  ],
  ["t06-instructions-unsafe", "instructions-unsafe", [pointer("/instructions", [])]],
  [
    "t06-skills-index-edge",
    "skills-index-edge",
    [pointer("/oversized/bodyLength", 255953), pointer("/oversized/marker", false)],
  ],
  [
    "t06-skills-mutations",
    "skills-mutations",
    [pointer("/builtinUnchanged", true), pointer("/deleted", true), pointer("/winner", "original")],
  ],
  [
    "t06-skills-validation",
    "skills-validation",
    [
      pointer("/valid", "a".repeat(64)),
      pointer("/projectMissing", "no project skill dir — run inside a project with .claude/skills"),
    ],
  ],
  [
    "t06-env-upsert",
    "env-upsert",
    [pointer("/mode", "0600"), pointer("/changed", ["A", "B"])],
    true,
  ],
  [
    "t06-env-same-key",
    "env-same-key",
    [pointer("/environment/SHARED", ""), pointer("/environment/ONLY_FILE", "yes")],
    true,
  ],
  ["t06-wizard-gates", "wizard-gates", [pointer("/3/offered", false), pointer("/2/offered", true)]],
  [
    "t06-wizard-configure",
    "wizard-configure",
    [
      pointer("/envKeys", ["LOHRA_PROVIDER", "ANTHROPIC_API_KEY"]),
      pointer("/keySet", true),
      pointer("/ready", true),
    ],
    true,
    [normalize("profile")],
  ],
  [
    "t06-wizard-eof",
    "wizard-eof",
    [pointer("/envKeys", ["LOHRA_PROVIDER"]), pointer("/keySet", false), pointer("/ready", false)],
    true,
    [normalize("profile")],
  ],
  [
    "t06-profile-errors",
    "profile-errors",
    [pointer("/missing/code", 2), pointer("/invalid/code", 2)],
  ],
  [
    "t06-profile-list-active",
    "profile-isolation",
    [pointer("/listed/stdout", "* p1\n  p2\n"), pointer("/values/p2/memory", "memory-p2")],
  ],
  [
    "t06-skill-export",
    "skill-export",
    [pointer("/missing/code", 2), pointer("/written/code", 0), pointer("/assetBytes", 4654)],
    true,
    [normalize("home")],
  ],
];
for (const [id, mode, expectations, tree = false, normalizations = []] of direct) {
  manifest({
    id,
    runners: directRunners(mode),
    expectations,
    tree,
    treeRoot: id === "t06-skill-export" ? "home" : "profile",
    normalizations,
  });
}
manifest({
  id: "t06-memory-utf16-mutant",
  runners: directRunners("memory-core", "memory-utf16-mutant"),
  expectations: [pointer("/boundary", true, "oracle"), pointer("/boundary", false, "candidate")],
});

manifest({
  id: "t06-profile-list-empty",
  argv: ["profile", "list"],
  runners: cliRunners,
  expectations: [
    {
      side: "both",
      field: "process.stdout",
      encoding: "utf8",
      value: "no profiles yet — create one with `lohra profile create <name>`\n",
    },
  ],
});
manifest({
  id: "t06-profile-create",
  argv: ["profile", "create", "team_a"],
  runners: cliRunners,
  tree: true,
  expectations: [{ side: "both", field: "tree", pointer: "/0/path", value: "profiles" }],
  normalizations: [normalize("profile")],
});
manifest({
  id: "t06-profile-create-existing",
  argv: ["profile", "create", "team_a"],
  runners: cliRunners,
  fixtures: [
    { root: "profile", path: "profiles/team_a/memories/.keep", encoding: "utf8", content: "keep" },
  ],
  tree: true,
  expectations: [{ side: "both", field: "tree", pointer: "/0/path", value: "profiles" }],
  normalizations: [normalize("profile")],
});
manifest({
  id: "t06-profile-subscription-note",
  argv: ["profile", "create", "subless"],
  runners: cliRunners,
  fixtures: [
    {
      root: "profile",
      path: "auth.json",
      encoding: "utf8",
      content:
        '{"openai":{"auth_mode":"subscription","acknowledged_tos_risk":true,"preference":"auto"}}',
    },
  ],
  tree: true,
  expectations: [{ side: "both", field: "tree", pointer: "/0/path", value: "auth.json" }],
  normalizations: [normalize("profile")],
});
const port = [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }];
manifest({
  id: "t06-init-no-input",
  argv: ["init", "--no-input"],
  runners: cliRunners,
  preconditions: port,
  tree: true,
  treeRoot: "home",
  expectations: [{ side: "both", field: "tree", value: [{ path: "tmp", type: "directory" }] }],
  normalizations: [normalize("profile")],
});
manifest({
  id: "t06-init-nontty",
  argv: ["init"],
  runners: cliRunners,
  preconditions: port,
  tree: true,
  treeRoot: "home",
  expectations: [{ side: "both", field: "tree", value: [{ path: "tmp", type: "directory" }] }],
  normalizations: [normalize("profile")],
});
manifest({
  id: "t06-doctor-readonly",
  argv: ["doctor", "--json"],
  runners: cliRunners,
  preconditions: port,
  tree: true,
  treeRoot: "home",
  expectedExit: 2,
  expectations: [
    pointer("/checks/0/name", "python"),
    pointer("/checks/11/name", "harnesses"),
    { side: "both", field: "tree", value: [{ path: "tmp", type: "directory" }] },
  ],
  normalizations: [normalize("profile"), normalize("home")],
});
manifest({
  id: "t06-cli-scope-shrink",
  runners: directRunners("scope-shrink"),
  stdout: false,
  expectations: [
    pointer("/implemented/init", true, "candidate"),
    pointer("/implemented/profile", true, "candidate"),
    pointer("/implemented/skill", true, "candidate"),
    pointer("/remaining", ["dashboard", "cron", "workflow", "update"], "candidate"),
    pointer("/help13", true, "candidate"),
  ],
});
