#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { resolveOracleWorkspace } from "../resolve.js";

const root = resolve(import.meta.dirname, "../../..");

// The T03 probes below (unlike the main harness) don't auto-discover the
// oracle workspace themselves — reuse the harness's own discovery here so
// this gate is portable across machines, not just wherever
// LOHRA_ORACLE_WORKSPACE happens to already be set.
const oracleWorkspace = resolveOracleWorkspace({
  cwd: root,
  timeoutMs: 60_000,
  maxOutputBytes: 16_777_216,
});

function command(
  argv: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("npm", argv, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * T03 (state/SQLite) has no consolidated regression suite script in this
 * worktree — only two standalone cross-verification probes. Both are run
 * here as T03's contribution to the T13 gate rather than omitted, and the
 * summary is honest about their narrower scope (a probe's own projection
 * digest, not a suite of expected-match/expected-divergent scenarios).
 */
const t03Probes = ["probe:state-cross-read", "probe:state-multiprocess"] as const;
const t03Results = [];
for (const script of t03Probes) {
  const result = command(["run", script], { LOHRA_ORACLE_WORKSPACE: oracleWorkspace.root });
  if (result.status !== 0)
    throw new Error(
      `T03_PROBE_FAILED:${script}:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
  const line = result.stdout
    .split("\n")
    .reverse()
    .find((value) => value.trimStart().startsWith("{"));
  t03Results.push({
    id: script,
    exitCode: result.status,
    summary: line ? (JSON.parse(line) as unknown) : null,
  });
}

// T02/T07/T08/T09/T10 are already chained serially, one layer down, by
// T10's own gate (it runs T02 directly, then T07/T08/T09 as sub-suites,
// then its own transport checks) — delegated to rather than re-run here,
// which would otherwise double every one of those suites under the same
// contended port lock for no additional signal.
const t10Result = command(["run", "parity:t10:gates"]);
if (t10Result.status !== 0)
  throw new Error(
    `T10_GATE_FAILED:${String(t10Result.status)}:${t10Result.stdout}:${t10Result.stderr}`,
  );
const t10Line = t10Result.stdout
  .split("\n")
  .reverse()
  .find((value) => value.trimStart().startsWith("{"));

process.stdout.write(
  `${JSON.stringify({
    suite: "t13-regression-gates",
    t03: t03Results,
    t02_t07_t08_t09_t10: {
      exitCode: t10Result.status,
      summary: t10Line ? (JSON.parse(t10Line) as unknown) : null,
    },
    failures: 0,
  })}\n`,
);
