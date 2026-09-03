#!/usr/bin/env node
// T02/T03/T08/T09 regression, run serially, each gate reported separately
// (contract's "Comandos de aceite propostos" section) -- T18 touches a
// shared file (src/serialization/python-json.ts, the NaN/Infinity parser
// extension) and the tool registry (src/commands/chat.ts), so this proves
// neither shared-file touch regressed anything already approved. Never
// loosens, normalizes, or re-baselines an earlier fixture to make T18 pass.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const scenarios = resolve(root, "scripts/parity/scenarios");

function command(argv: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
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

function runManifestGroup(prefix: string): {
  readonly id: string;
  readonly exitCode: number | null;
  readonly expected: number;
  readonly pass: boolean;
}[] {
  const names = readdirSync(scenarios)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json"))
    .sort();
  const results: {
    readonly id: string;
    readonly exitCode: number | null;
    readonly expected: number;
    readonly pass: boolean;
  }[] = [];
  for (const name of names) {
    const result = command(["run", "parity", "--", "--manifest", resolve(scenarios, name)]);
    // Both naming conventions this repo uses for a deliberately-broken
    // variant that must diverge, not match: T02's "-deliberate-divergence"
    // and T03's "-mutant" suffix (e.g. t03-schema-stale-write-mutant.json).
    const expected = name.includes("deliberate-divergence") || name.includes("-mutant") ? 1 : 0;
    const pass = result.status === expected;
    results.push({ id: name.slice(0, -5), exitCode: result.status, expected, pass });
    if (!pass)
      throw new Error(
        `T18_GATE_FAILED:${name}:${String(result.status)}:${result.stdout}:${result.stderr}`,
      );
  }
  return results;
}

const t02 = runManifestGroup("t02");
const t03 = runManifestGroup("t03");

function lastJsonLine(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .reverse()
    .find((value) => value.trimStart().startsWith("{"));
  return line ? (JSON.parse(line) as unknown) : null;
}

const suites = [
  ["t08", "parity:t08:all"],
  ["t09", "parity:t09:all"],
] as const;
const suiteResults: {
  readonly id: string;
  readonly exitCode: number | null;
  readonly summary: unknown;
}[] = [];
for (const [id, script] of suites) {
  const result = command(["run", script]);
  if (result.status !== 0)
    throw new Error(
      `${id.toUpperCase()}_GATE_FAILED:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
  suiteResults.push({ id, exitCode: result.status, summary: lastJsonLine(result.stdout) });
}

process.stdout.write(
  `${JSON.stringify({ suite: "t18-regression-gates", t02, t03, suites: suiteResults, failures: 0 })}\n`,
);
