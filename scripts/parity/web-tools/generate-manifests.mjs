#!/usr/bin/env node
/* Generates the T20 bilateral manifests from one measured run of each driver.
 * Every expectation is pinned from observed stdout; nothing here loosens a
 * comparison. Re-run only when a driver or the contract changes. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const oracleDriver = "scripts/parity/web-tools/oracle_driver.py";
const candidateDriver = "scripts/parity/web-tools/candidate-driver.mjs";
const manifestDirectory = resolve(root, "scripts/parity/manifests/t20");
mkdirSync(manifestDirectory, { recursive: true });

function oraclePython() {
  return process.env.LOHRA_T20_ORACLE_PYTHON ?? "python3";
}

const matchScenarios = [
  "definitions",
  "chat-canned",
  "missing-arguments",
  "coercions",
  "scheme-host",
  "dns-failures",
  "non-public-hostname",
  "redirect-limits",
  "content-types",
  "encoding",
  "ddg-flow",
  "ddg-empty-and-clamp",
  "transport-failures",
  "registry-boundary",
];

const divergentScenarios = [
  "port-invalid",
  "userinfo",
  "non-public-literals",
  "literal-public",
  "redirect-flow",
  "fetch-bounds",
  "peer-matrix",
  "ddg-byte-cap",
];

function run(command, argv) {
  return execFileSync(command, argv, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function expectationRows(oracleStdout, candidateStdout, divergent) {
  const expectations = [
    { side: "both", field: "process.exitCode", value: 0 },
    { side: "both", field: "process.signal", value: null },
  ];
  if (divergent) {
    expectations.push({ side: "oracle", field: "process.stdout", encoding: "utf8", value: oracleStdout });
    expectations.push({ side: "candidate", field: "process.stdout", encoding: "utf8", value: candidateStdout });
  } else {
    expectations.push({ side: "both", field: "process.stdout", encoding: "utf8", value: oracleStdout });
  }
  return expectations;
}

for (const scenario of [...matchScenarios, ...divergentScenarios]) {
  const oracleStdout = run(oraclePython(), [join(root, oracleDriver), scenario]);
  const candidateStdout = run(process.execPath, [join(root, candidateDriver), scenario]);
  const divergent = !matchScenarios.includes(scenario);
  const manifest = {
    schemaVersion: 1,
    id: `t20-${scenario}`,
    description: `T20 bilateral observation: ${scenario}${divergent ? " (expected divergent)" : ""}`,
    argv: [scenario],
    environment: {
      allow: [],
      set: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONUTF8: "1",
        PYTHONHASHSEED: "0",
        NO_COLOR: "1",
        TZ: "UTC",
        HOME: "{{home}}",
        TMPDIR: "{{home}}/tmp",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
      },
    },
    preconditions: [],
    fixtures: [],
    runners: {
      oracle: {
        adapter: "python",
        executable: "oracle-python",
        prefixArgs: [`{{projectRoot}}/${oracleDriver}`],
        cwd: "profile",
      },
      candidate: {
        adapter: "typescript",
        executable: "node",
        prefixArgs: [`{{projectRoot}}/${candidateDriver}`],
        cwd: "profile",
      },
    },
    limits: { timeoutMs: 60_000, maxOutputBytes: 16_777_216 },
    capture: { tree: { enabled: false, root: "profile", exclude: [] }, sqlite: [], events: [] },
    comparisons: [
      { class: "byte", field: "process.exitCode" },
      { class: "byte", field: "process.signal" },
      { class: "byte", field: "process.stdout" },
    ],
    expectations: expectationRows(oracleStdout, candidateStdout, divergent),
    normalizations: [],
    scrub: { fixtureTokens: true, operatorCredentials: true },
    oracleGuard: {
      expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
      expectedVersion: "lohra 0.0.11\n",
      expectedPythonVersion: "3.12.10",
      expectedPackages: { openai: "3.6.0", httpx: "0.28.1" },
    },
  };
  const payload = JSON.stringify(manifest, null, 2);
  if (payload.includes("/Users/")) {
    throw new Error(`manifest ${scenario} leaked an author-local path`);
  }
  writeFileSync(join(manifestDirectory, `t20-${scenario}.json`), `${payload}\n`);
  process.stdout.write(`wrote t20-${scenario} (${divergent ? "divergent" : "match"})\n`);
}

process.exitCode = 0;
