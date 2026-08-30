#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const matches = [
  "registry-shape",
  "valid-minimal",
  "valid-doc-fixture",
  "valid-all-node-types",
  "validation-top-level",
  "validation-meta",
  "validation-schemas",
  "validation-node-shape",
  "validation-supported",
  "validation-fields",
  "validation-schema",
  "validation-refs",
  "validation-lifecycle",
  "validation-tier",
  "validation-gate",
  "validation-fanout",
  "validation-duplicates",
  "validation-cascade",
  "validation-multi-canonical",
  "validation-cycle-canonical",
  "normalization-quirks",
  "refs-grammar",
  "refs-resolve",
  "refs-numeric",
  "refs-strict",
  "graph-dependencies",
  "graph-topological",
  "jsonio-lenient",
  "policy-normalization",
];
const mutants = [
  ["mutant-ascii-ref", "refs-grammar", "ascii-ref"],
  ["mutant-topo-id-sort", "graph-topological", "topo-id-sort"],
  ["mutant-js-stringify", "refs-numeric", "js-stringify"],
];
const environment = {
  allow: [],
  set: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUTF8: "1",
    NO_COLOR: "1",
    COLUMNS: "80",
    TZ: "UTC",
    PYTHONHASHSEED: "0",
    PYTHONDONTWRITEBYTECODE: "1",
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
const fixture = "{{projectRoot}}/scripts/parity/workflow-spec/fixtures/cases.json";
const semanticExpectations = {
  "registry-shape": ["/cases/0/outcome/constants/MAX_STATIC_FANOUT", 64],
  "valid-minimal": ["/cases/0/outcome/kind", "workflow_spec"],
  "valid-doc-fixture": ["/cases/0/outcome/nodes/2/id", "report"],
  "valid-all-node-types": ["/cases/0/outcome/nodes/9/type", "workflow"],
  "validation-fields": ["/cases/0/outcome/issues/0/0", "unknown_field"],
  "validation-cycle-canonical": ["/cases/0/outcome/issues/0/cycle_edges/3", "c->a"],
  "refs-grammar": ["/cases/0/outcome/arabicValid", true],
  "refs-resolve": ["/cases/0/outcome/index", 8],
  "refs-numeric": ["/cases/0/outcome/float", "v=1.0"],
  "refs-strict": ["/cases/0/outcome/missing/1", "a.none"],
  "graph-dependencies": ["/cases/0/outcome/dependencies/d/0", "a"],
  "graph-topological": ["/cases/0/outcome/topological/1", "c"],
  "jsonio-lenient": ["/cases/0/outcome/3", "nan"],
  "policy-normalization": ["/cases/0/outcome/fsAllow/1/writable", false],
};

function manifest(id, oracleMode, candidateMode, mutant = "") {
  const oracleArgs = [
    "{{projectRoot}}/scripts/parity/workflow-spec/oracle_driver.py",
    oracleMode,
    fixture,
  ];
  const result = {
    schemaVersion: 1,
    id: `t14-${id}`,
    description: `T14 workflow spec/DAG: ${id}`,
    argv: [],
    environment,
    preconditions: [],
    fixtures: [],
    runners: {
      oracle: {
        adapter: "python",
        executable: "oracle-python",
        prefixArgs: oracleArgs,
        cwd: "sandbox",
      },
      candidate: {
        adapter: "typescript",
        executable: "node",
        prefixArgs: [
          "{{projectRoot}}/scripts/parity/workflow-spec/candidate-driver.mjs",
          candidateMode,
          fixture,
          mutant,
        ],
        cwd: "sandbox",
      },
    },
    limits: { timeoutMs: 15000, maxOutputBytes: 4194304 },
    capture: { tree: { enabled: false, root: "home", exclude: [] }, sqlite: [], events: [] },
    comparisons: [
      { class: "byte", field: "process.exitCode" },
      { class: "byte", field: "process.signal" },
      { class: "probe", field: "process.stdout" },
      { class: "byte", field: "process.stderr" },
    ],
    expectations: [
      { side: "both", field: "process.exitCode", value: 0 },
      { side: "both", field: "process.signal", value: null },
      { side: "both", field: "process.stderr", encoding: "utf8", value: "" },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/operation",
        value: oracleMode,
      },
      {
        side: "both",
        field: "process.stdout",
        encoding: "utf8",
        pointer: "/cases/0/id",
        value: oracleMode,
      },
    ],
    normalizations: [],
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: guard,
  };
  if (oracleMode === "policy-normalization") {
    result.fixtures = [
      {
        root: "home",
        path: "policy.json",
        encoding: "utf8",
        content: JSON.stringify({
          fs_allow: ["/rw", { path: "/ro", mode: "ro" }, { path: "/bad", mode: "bad" }, {}],
          egress_allow: ["api.test", 7, ""],
        }),
      },
    ];
  }
  if (oracleMode === "validation-cycle-canonical") {
    result.capture.events = [
      {
        name: "cycleRaw",
        root: "home",
        path: "cycle-raw.json",
        format: "json",
        projection: "raw-only",
      },
    ];
  }
  const semantic = semanticExpectations[id];
  if (semantic) {
    result.expectations.push({
      side: "both",
      field: "process.stdout",
      encoding: "utf8",
      pointer: semantic[0],
      value: semantic[1],
    });
  }
  return result;
}

const output = resolve("scripts/parity/scenarios");
mkdirSync(output, { recursive: true });
for (const id of matches) {
  writeFileSync(
    resolve(output, `t14-${id}.json`),
    `${JSON.stringify(manifest(id, id, id), null, 2)}\n`,
  );
}
for (const [id, base, mutation] of mutants) {
  writeFileSync(
    resolve(output, `t14-${id}.json`),
    `${JSON.stringify(manifest(id, base, id, mutation), null, 2)}\n`,
  );
}
