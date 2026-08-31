#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

/**
 * The three probe-complementar scenarios (contract §"3 probes
 * [probe-complementar]") each live as a single, precisely-named vitest test
 * rather than a standalone TS-only script — every one of them is exactly
 * the named-mutant unit proof the contract asks for, not a wire scenario.
 * `-t` filters vitest to just that test; since a filter matching ZERO tests
 * still exits 0 (every test reports "skipped", not "failed"), this script
 * parses the "Tests  N passed" line itself rather than trusting the exit
 * code alone — a typo'd test name must fail this gate, not silently pass.
 */
const probes = [
  {
    id: "t13-attribution-suppression-unit-static",
    file: "tests/orchestration-core-steer.test.ts",
    name: "L12: model/provider are structurally identical across every resurrection",
  },
  {
    id: "t13-serializer-mutant-killed-result-field",
    file: "tests/tools-security-lifecycle.test.ts",
    name: "emits Python-shaped start/complete pairs with session-local ids",
  },
  {
    id: "t13-child-prompt-frozen-instrumented-builder-not-recalled",
    file: "tests/orchestration-core.test.ts",
    name: "captures the subagent system prompt once at spawn and never calls the builder again for that sub_id",
  },
] as const;

let failures = 0;
const results: { readonly id: string; readonly passed: number; readonly pass: boolean }[] = [];
for (const probe of probes) {
  const result = spawnSync(
    "npx",
    ["vitest", "run", probe.file, "-t", probe.name, "--reporter=default"],
    { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const match = /Tests\s+(\d+) passed/u.exec(result.stdout);
  const passed = match?.[1] === undefined ? 0 : Number(match[1]);
  const pass = result.status === 0 && passed >= 1;
  if (!pass) failures += 1;
  results.push({ id: probe.id, passed, pass });
}

process.stdout.write(`${JSON.stringify({ suite: "t13-probe-complementar", probes: results, failures })}\n`);
process.exitCode = failures === 0 ? 0 : 1;
