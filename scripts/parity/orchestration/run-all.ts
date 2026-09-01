#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "../canonical.js";
import { runCli } from "../cli.js";

const manifests = resolve("scripts/parity/manifests/t13");
const evidenceDirectory = resolve(".parity-evidence/t13");
const patchedDirectory = resolve(evidenceDirectory, "_patched");
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(patchedDirectory, { recursive: true });

const names = readdirSync(manifests)
  .filter((name) => name.startsWith("t13-") && name.endsWith(".json"))
  .sort();

/**
 * The child-prompt-freeze manifest (item 25) pins today's date inside four
 * expectation values, since expectations can never be normalized (only
 * `comparisons` can — see harness.ts's expectationFailures, which reads the
 * raw captured field directly). Its "<TODAY>" placeholder is substituted
 * here with the exact expression buildSystemPrompt itself uses, so the
 * suite's digest stays reproducible on any calendar day rather than only
 * the day the manifest was authored.
 */
function manifestPath(name: string): string {
  const original = resolve(manifests, name);
  const text = readFileSync(original, "utf8");
  if (!text.includes("<TODAY>")) return original;
  const today = new Date().toISOString().slice(0, 10);
  const patched = resolve(patchedDirectory, name);
  writeFileSync(patched, text.replaceAll("<TODAY>", today));
  return patched;
}

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

/**
 * Round-2 F4 is deliberately a versioned bilateral matrix, not a loose pile
 * of manifests. Keep its cardinality and every warning/usage observable
 * machine-checked here so deleting a row, turning the empty-env fallback into
 * a warning, or producing equal-but-empty stderr cannot still yield a green
 * aggregate suite.
 */
const fanoutMatrix = new Map<string, string | null>([
  ["t13-fanout-default-four", null],
  ["t13-fanout-flag-one", null],
  ["t13-fanout-flag-two", null],
  ["t13-fanout-flag-zero-clamps-one", null],
  ["t13-fanout-flag-negative-clamps-one", null],
  ["t13-fanout-env-two", null],
  ["t13-fanout-env-zero-falls-back-four", "ignoring LOHRA_MAX_PARALLEL='0': must be >= 1; using 4"],
  [
    "t13-fanout-env-negative-falls-back-four",
    "ignoring LOHRA_MAX_PARALLEL='-5': must be >= 1; using 4",
  ],
  [
    "t13-fanout-clamp-not-an-integer-warning",
    "ignoring LOHRA_MAX_PARALLEL='abc': not an integer; using 4",
  ],
  ["t13-fanout-env-empty-falls-back-four-silent", null],
  [
    "t13-fanout-env-float-falls-back-four",
    "ignoring LOHRA_MAX_PARALLEL='3.0': not an integer; using 4",
  ],
  ["t13-fanout-precedence-flag-three-over-env-one", null],
  ["t13-fanout-precedence-flag-one-over-env-five", null],
  ["t13-fanout-env-padded-two", null],
  ["t13-fanout-env-plus-two", null],
  ["t13-fanout-env-underscore-ten", null],
  [
    "t13-fanout-env-repr-apostrophe-backslash",
    'ignoring LOHRA_MAX_PARALLEL="a\'b\\\\c": not an integer; using 4',
  ],
]);
const invalidFlagId = "t13-fanout-flag-noninteger-usage";

function decodedStderr(run: unknown): string | null {
  if (typeof run !== "object" || run === null) return null;
  const stderr = (run as { readonly process?: { readonly stderr?: unknown } }).process?.stderr;
  if (typeof stderr !== "string") return null;
  return Buffer.from(stderr, "base64").toString("utf8");
}

let failures = 0;
const projections: {
  readonly id: string;
  readonly sha: string;
  readonly evidenceSha: string;
  readonly class: string;
}[] = [];
for (const name of names) {
  const id = name.slice(0, -5);
  const evidence = resolve(evidenceDirectory, `${id}.json`);
  rmSync(evidence, { force: true });
  const expectedCode = divergent.has(id) ? 1 : 0;
  const code = runCli(["--manifest", manifestPath(name), "--evidence", evidence]);
  if (code !== expectedCode) failures += 1;
  try {
    const parsed = JSON.parse(readFileSync(evidence, "utf8")) as {
      readonly scenario: { readonly manifestSha256: string };
      readonly verdict: string;
      readonly comparison: { readonly normalized: unknown };
      readonly expectations: { readonly failures: readonly unknown[] };
      readonly reproducibility: { readonly projectionSha256: string };
      readonly runs: { readonly oracle: unknown; readonly candidate: unknown };
    };
    const expectedVerdict = divergent.has(id) ? "divergent" : "match";
    if (parsed.verdict !== expectedVerdict) failures += 1;
    if (fanoutMatrix.has(id)) {
      const expectedWarning = fanoutMatrix.get(id) ?? null;
      for (const run of [parsed.runs.oracle, parsed.runs.candidate]) {
        const stderr = decodedStderr(run);
        if (stderr === null) failures += 1;
        else if (expectedWarning === null && stderr.startsWith("ignoring LOHRA_MAX_PARALLEL="))
          failures += 1;
        else if (expectedWarning !== null && stderr.split("\n", 1)[0] !== expectedWarning)
          failures += 1;
      }
    }
    if (id === invalidFlagId) {
      for (const run of [parsed.runs.oracle, parsed.runs.candidate]) {
        const stderr = decodedStderr(run);
        if (stderr === null || !stderr.startsWith("usage:")) failures += 1;
      }
    }
    const judgedProjection = {
      manifestSha256: parsed.scenario.manifestSha256,
      expectedVerdict,
      verdict: parsed.verdict,
      normalized: parsed.comparison.normalized,
      expectationFailures: parsed.expectations.failures,
      fanoutExpectedWarning: fanoutMatrix.get(id),
      invalidFlagUsageRequired: id === invalidFlagId,
    };
    projections.push({
      id,
      sha: createHash("sha256").update(canonicalJson(judgedProjection), "utf8").digest("hex"),
      evidenceSha: parsed.reproducibility.projectionSha256,
      class: parsed.verdict,
    });
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
for (const id of [...fanoutMatrix.keys(), invalidFlagId]) {
  if (!names.includes(`${id}.json`)) failures += 1;
}
const result = {
  suite: "t13-orchestration-delegation",
  scenarios: names.length,
  contractAssertions: 51,
  failures,
  expectedMatches,
  expectedDivergences: divergent.size,
  fanoutMatrixScenarios: fanoutMatrix.size + 1,
  digest,
  digestFormula:
    "sha256(sorted UTF-8 lines id=judgedProjectionSha256\\n; judged projection = manifest SHA + expected/actual verdict + comparison.normalized + expectation failures + runner assertions; trailing newline included; contract T13 ids only)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode =
  failures === 0 && names.length === projections.length && names.length > 0 ? 0 : 1;
