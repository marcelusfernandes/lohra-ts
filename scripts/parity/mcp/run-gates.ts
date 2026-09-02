#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const manifests = resolve(root, "scripts/parity/scenarios");
const gateRuntime = mkdtempSync(join(tmpdir(), "lohra-t19-gates-"));
const gateEnv: Readonly<Record<string, string>> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: gateRuntime,
  TMPDIR: gateRuntime,
  LANG: "C.UTF-8",
  TZ: "UTC",
  NO_COLOR: "1",
};

process.once("exit", () => {
  rmSync(gateRuntime, { recursive: true, force: true });
});

function npm(argv: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("npm", argv, {
    cwd: root,
    env: gateEnv,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function lastJson(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .toReversed()
    .find((value) => value.trimStart().startsWith("{"));
  return line === undefined ? null : (JSON.parse(line) as unknown);
}

const individual = readdirSync(manifests)
  .filter((name) => /^(t02|t03)-.*\.json$/u.test(name))
  .sort();
const expectedDivergences = new Set([
  "t02-deliberate-divergence.json",
  "t03-schema-stale-write-mutant.json",
]);
const individualResults = [];
for (const name of individual) {
  const result = npm(["run", "parity", "--", "--manifest", resolve(manifests, name)]);
  const expected = expectedDivergences.has(name) ? 1 : 0;
  const pass = result.status === expected;
  individualResults.push({ id: name.slice(0, -5), exitCode: result.status, expected, pass });
  if (!pass) {
    throw new Error(
      `T19_REGRESSION_GATE_FAILED:${name}:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
  }
}

const suites = [
  ["t08", "parity:t08:all"],
  ["t09", "parity:t09:all"],
] as const;
const suiteResults = [];
for (const [id, script] of suites) {
  const result = npm(["run", script]);
  if (result.status !== 0) {
    throw new Error(
      `T19_REGRESSION_GATE_FAILED:${id}:${String(result.status)}:${result.stdout}:${result.stderr}`,
    );
  }
  suiteResults.push({ id, exitCode: result.status, summary: lastJson(result.stdout) });
}

process.stdout.write(
  `${JSON.stringify({
    suite: "t19-regression-gates",
    individual: individualResults,
    suites: suiteResults,
    failures: 0,
  })}\n`,
);
