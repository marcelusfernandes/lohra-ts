#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const scenarios = resolve("scripts/parity/scenarios");
const evidenceDirectory = resolve(".parity-evidence");
mkdirSync(evidenceDirectory, { recursive: true });
const names = readdirSync(scenarios)
  .filter((name) => name.startsWith("t06-") && name.endsWith(".json"))
  .sort();
let failures = 0;
const projections: { readonly id: string; readonly sha: string }[] = [];
for (const name of names) {
  const id = name.slice(0, -5);
  const evidence = resolve(evidenceDirectory, `${id}.json`);
  const code = runCli(["--manifest", resolve(scenarios, name), "--evidence", evidence]);
  const expected = id === "t06-memory-utf16-mutant" ? 1 : 0;
  if (code !== expected) failures += 1;
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
  .sort((left, right) => left.id.localeCompare(right.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput).digest("hex");
process.stdout.write(
  `${JSON.stringify({ suite: "t06-local-context", scenarios: names.length, failures, digest, digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n)", projections })}\n`,
);
process.exitCode = failures === 0 && names.length === 28 ? 0 : 1;
