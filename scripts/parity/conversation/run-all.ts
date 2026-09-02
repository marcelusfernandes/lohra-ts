#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const manifests = resolve("scripts/parity/manifests/t08");
const evidenceDirectory = resolve(".parity-evidence/t08");
mkdirSync(evidenceDirectory, { recursive: true });

const names = readdirSync(manifests)
  .filter((name) => name.startsWith("t08-") && name.endsWith(".json"))
  .sort();
const divergent = new Set([
  "t08-chat-complete-tool-hardening",
  "t08-chat-unknown-tool-hardening",
  "t08-mutant-error-persists-message",
  "t08-mutant-json-stringify",
  "t08-mutant-prompt-not-stored",
  "t08-mutant-resume-cumulative-turn-usage",
  "t08-mutant-session-on-error",
  "t08-mutant-usage-zero-fields",
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
    projections.push({
      id,
      sha: parsed.reproducibility.projectionSha256,
      class: parsed.verdict,
    });
  } catch {
    failures += 1;
  }
}

const digestInput = projections
  .toSorted((left, right) => left.id.localeCompare(right.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t08-conversation-runtime",
  scenarios: names.length,
  failures,
  expectedMatches: 10,
  expectedDivergences: 8,
  digest,
  digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && names.length === 18 && projections.length === 18 ? 0 : 1;
