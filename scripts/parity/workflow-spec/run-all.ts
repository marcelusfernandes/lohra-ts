#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const scenarios = resolve("scripts/parity/scenarios");
const evidenceDirectory = resolve(".parity-evidence");
mkdirSync(evidenceDirectory, { recursive: true });
const names = readdirSync(scenarios)
  .filter((name) => name.startsWith("t14-") && name.endsWith(".json"))
  .sort();
const mutants = new Set([
  "t14-mutant-ascii-ref",
  "t14-mutant-topo-id-sort",
  "t14-mutant-js-stringify",
]);
let failures = 0;
const projections: { readonly id: string; readonly sha: string }[] = [];
for (const name of names) {
  const id = name.slice(0, -5);
  const evidence = resolve(evidenceDirectory, `${id}.json`);
  const code = runCli(["--manifest", resolve(scenarios, name), "--evidence", evidence]);
  if (code !== (mutants.has(id) ? 1 : 0)) failures += 1;
  try {
    const parsed = JSON.parse(readFileSync(evidence, "utf8")) as {
      readonly reproducibility: { readonly projectionSha256: string };
    };
    projections.push({ id, sha: parsed.reproducibility.projectionSha256 });
  } catch {
    failures += 1;
  }
}
const digestInput = projections
  .sort((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput).digest("hex");
process.stdout.write(
  `${JSON.stringify({ suite: "t14-workflow-spec", scenarios: names.length, failures, expectedMatches: 29, expectedDivergences: 3, digest, digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)", projections })}\n`,
);
process.exitCode = failures === 0 && names.length === 32 && projections.length === 32 ? 0 : 1;
