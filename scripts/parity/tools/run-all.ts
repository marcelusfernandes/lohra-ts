#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const manifests = resolve("scripts/parity/manifests/t09");
const evidenceDirectory = resolve(".parity-evidence/t09");
mkdirSync(evidenceDirectory, { recursive: true });

const names = readdirSync(manifests)
  .filter((name) => name.startsWith("t09-") && name.endsWith(".json"))
  .sort();
const divergent = new Set([
  "t09-child-unknown-hardening",
  "t09-child-terminal-type-hardening",
  "t09-mutant-json-stringify",
  "t09-mutant-utf16-truncation",
  "t09-mutant-ttl-inclusive",
  "t09-mutant-gate-after-exec",
  "t09-mutant-resume-stored-prompt",
]);

let failures = 0;
const projections: { readonly id: string; readonly sha: string; readonly class: string }[] = [];
for (const name of names) {
  const id = name.slice(0, -5);
  const evidence = resolve(evidenceDirectory, `${id}.json`);
  rmSync(evidence, { force: true });
  const expectedCode = divergent.has(id) ? 1 : 0;
  const code = runCli(["--manifest", resolve(manifests, name), "--evidence", evidence]);
  if (code !== expectedCode) failures += 1;
  try {
    const parsed = JSON.parse(readFileSync(evidence, "utf8")) as {
      readonly verdict: string;
      readonly reproducibility: { readonly projectionSha256: string };
    };
    const expectedVerdict = divergent.has(id) ? "divergent" : "match";
    if (parsed.verdict !== expectedVerdict) failures += 1;
    projections.push({ id, sha: parsed.reproducibility.projectionSha256, class: parsed.verdict });
  } catch {
    failures += 1;
  }
}
const digestInput = projections
  .toSorted((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t09-local-tools-platform",
  scenarios: names.length,
  contractAssertions: 80,
  failures,
  expectedMatches: 31,
  expectedDivergences: 7,
  digest,
  digestFormula:
    "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included; contract T09 ids only)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && names.length === 38 && projections.length === 38 ? 0 : 1;
