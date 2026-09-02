#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const suites = [
  ["t09", "parity:t09:all"],
  ["t10", "parity:t10"],
  ["t11", "parity:t11"],
] as const;

const APPROVED_DIGESTS: Readonly<Record<(typeof suites)[number][0], string>> = Object.freeze({
  t09: "e6327b5c3c48158a49a85bc0b332291f39052e3f40395f097821e9d0a48219f5",
  t10: "635f56867579c85fc51293e83223065c56cbac9269902b55b91662c2b1c8fd44",
  t11: "d9e909a4cf20bd2a89a5802794164cd3733771eb1ca5c65a2c5f8bdcf4907c1e",
});

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
  const summary = line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
  if (summary?.["digest"] !== APPROVED_DIGESTS[id])
    throw new Error(
      `${id.toUpperCase()}_DIGEST_CHANGED:${String(summary?.["digest"])}:${APPROVED_DIGESTS[id]}`,
    );
  results.push({ id, exitCode: 0, summary });
}

process.stdout.write(
  `${JSON.stringify({ suite: "t21-regression-gates", suites: results, failures: 0 })}\n`,
);
