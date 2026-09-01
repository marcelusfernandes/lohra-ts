#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const suites = [
  ["t09", "parity:t09:all"],
  ["t10", "parity:t10"],
  ["t11", "parity:t11"],
] as const;

const results: Array<{ id: string; exitCode: number; summary: unknown }> = [];
for (const [id, script] of suites) {
  const run = spawnSync("npm", ["run", script], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0)
    throw new Error(
      `${id.toUpperCase()}_GATE_FAILED:${String(run.status ?? run.signal)}:${run.stdout}:${run.stderr}`,
    );
  const line = run.stdout
    .split("\n")
    .reverse()
    .find((value) => value.trimStart().startsWith("{"));
  results.push({ id, exitCode: 0, summary: line === undefined ? null : JSON.parse(line) });
}

process.stdout.write(
  `${JSON.stringify({ suite: "t21-regression-gates", suites: results, failures: 0 })}\n`,
);
