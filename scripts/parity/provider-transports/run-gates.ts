#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const scenarios = resolve(root, "scripts/parity/scenarios");

function command(argv: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("npm", argv, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const t02 = readdirSync(scenarios)
  .filter((name) => name.startsWith("t02-") && name.endsWith(".json"))
  .sort();
const t02Results = [];
for (const name of t02) {
  const result = command(["run", "parity", "--", "--manifest", resolve(scenarios, name)]);
  const expected = name === "t02-deliberate-divergence.json" ? 1 : 0;
  const pass = result.status === expected;
  t02Results.push({ id: name.slice(0, -5), exitCode: result.status, expected, pass });
  if (!pass)
    throw new Error(
      `T02_GATE_FAILED:${name}:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
}

const suites = [
  ["t07", "parity:chat-completions"],
  ["t08", "parity:t08:all"],
  ["t09", "parity:t09:all"],
] as const;
const suiteResults = [];
for (const [id, script] of suites) {
  const result = command(["run", script]);
  if (result.status !== 0)
    throw new Error(
      `${id.toUpperCase()}_GATE_FAILED:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
  const line = result.stdout
    .split("\n")
    .reverse()
    .find((value) => value.trimStart().startsWith("{"));
  suiteResults.push({
    id,
    exitCode: result.status,
    summary: line ? (JSON.parse(line) as unknown) : null,
  });
}

process.stdout.write(
  `${JSON.stringify({ suite: "t10-regression-gates", t02: t02Results, suites: suiteResults, failures: 0 })}\n`,
);
