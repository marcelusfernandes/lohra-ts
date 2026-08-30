#!/usr/bin/env node
// Assertion 73: T02/T07/T08/T09/T10 regressions run serially after T11 and
// must conserve their approved expectations/digests — nothing here loosens,
// normalizes, or re-baselines an earlier fixture to make T11 pass. Reuses
// scripts/parity/provider-transports/run-gates.ts (already T02+T07+T08+T09)
// and adds T10's own suite + probes, reporting every gate separately.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

function command(argv: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npm", argv, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .reverse()
    .find((value) => value.trimStart().startsWith("{"));
  return line ? (JSON.parse(line) as unknown) : null;
}

const gates: { readonly id: string; readonly argv: readonly string[] }[] = [
  { id: "t02-t07-t08-t09", argv: ["run", "parity:t10:gates"] },
  { id: "t10", argv: ["run", "parity:t10"] },
  { id: "t10-probes", argv: ["run", "parity:t10:probes"] },
];

const results = [];
let failures = 0;
for (const gate of gates) {
  const result = command(gate.argv);
  const pass = result.status === 0;
  if (!pass) failures += 1;
  results.push({ id: gate.id, exitCode: result.status, pass, summary: lastJsonLine(result.stdout) });
  if (!pass)
    throw new Error(`T11_GATE_FAILED:${gate.id}:${String(result.status)}:${result.stdout}:${result.stderr}`);
}

process.stdout.write(`${JSON.stringify({ suite: "t11-regression-gates", results, failures })}\n`);
process.exitCode = failures === 0 ? 0 : 1;
