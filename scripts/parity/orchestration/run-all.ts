#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const manifests = resolve("scripts/parity/manifests/t13");
const evidenceDirectory = resolve(".parity-evidence/t13");
mkdirSync(evidenceDirectory, { recursive: true });

const names = readdirSync(manifests)
  .filter((name) => name.startsWith("t13-") && name.endsWith(".json"))
  .sort();

/**
 * The one scenario that is divergent BY DESIGN (contract decision 3, errata
 * E2 second half): a non-string terminal command is refused on both sides,
 * but with different messages — the child's own hardening text vs the
 * oracle's guard-miss text. Declaring it here (exit code + verdict + count,
 * not just the manifest's own description prose) is what makes "diverges
 * for the RIGHT reason" auditable rather than indistinguishable from a
 * silent regression that also happens to diverge.
 */
const divergent = new Set(["t13-delegate-child-terminal-nonstring-divergence"]);

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
const expectedMatches = names.length - divergent.size;
const result = {
  suite: "t13-orchestration-delegation",
  scenarios: names.length,
  contractAssertions: 51,
  failures,
  expectedMatches,
  expectedDivergences: divergent.size,
  digest,
  digestFormula:
    "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included; contract T13 ids only)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode =
  failures === 0 && names.length === projections.length && names.length > 0 ? 0 : 1;
