#!/usr/bin/env node
/* T20 parity suite — runs every bilateral manifest twice on the same SHA,
 * asserts inventory equality, non-empty expectations and an identical
 * canonical digest, then writes the evidence summary. Holds the lane lock for
 * acquisition + work + release within this single invocation. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { writeEvidence } from "../evidence.js";
import { runScenario } from "../harness.js";
import { parseScenarioManifest } from "../manifest.js";

const root = resolve(import.meta.dirname, "../../..");
const manifests = resolve(root, "scripts/parity/manifests/t20");
const evidenceDirectory = resolve(root, ".parity-evidence/t20");
rmSync(resolve(evidenceDirectory, "unused-placeholder"), { force: true });

const LOCK_PATH = "/tmp/lohra-parity-11434.lock";
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_RETRY_MS = 200;

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseLock() {
  rmSync(LOCK_PATH, { force: true });
}

const expectedDivergent = new Set([
  "t20-port-invalid",
  "t20-userinfo",
  "t20-non-public-literals",
  "t20-literal-public",
  "t20-redirect-flow",
  "t20-fetch-bounds",
  "t20-peer-matrix",
  "t20-ddg-byte-cap",
]);

function runPass(onlyScenarios?: ReadonlySet<string>) {
  const names = readdirSync(manifests)
    .filter((name) => name.startsWith("t20-") && name.endsWith(".json"))
    .filter((name) => onlyScenarios === undefined || onlyScenarios.has(name.slice(0, -5)))
    .sort();
  const projections = [];
  let failures = 0;
  for (const name of names) {
    const id = name.slice(0, -5);
    const evidencePath = resolve(evidenceDirectory, `${id}.json`);
    let record;
    try {
      const manifest = parseScenarioManifest(JSON.parse(readFileSync(resolve(manifests, name), "utf8")));
      record = runScenario(manifest, { cwd: root, projectRoot: root });
      writeEvidence(evidencePath, record, manifest);
    } catch (error) {
      process.stderr.write(`t20 harness error [${id}]: ${error instanceof Error ? error.message : String(error)}\n`);
      failures += 1;
      continue;
    }
    const expectedVerdict = expectedDivergent.has(id) ? "divergent" : "match";
    if (record.verdict !== expectedVerdict) {
      process.stderr.write(
        `t20 verdict mismatch [${id}]: expected ${expectedVerdict}, received ${record.verdict}\n`,
      );
      failures += 1;
    }
    if (record.expectationPolicy.length === 0) {
      process.stderr.write(`t20 empty expectations [${id}]\n`);
      failures += 1;
    }
    projections.push({ id, sha: record.reproducibility.projectionSha256, verdict: record.verdict });
  }
  const digestInput = projections
    .map((entry) => `${entry.id}=${entry.sha}\n`)
    .join("");
  const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
  return { projections, digest, failures, names };
}

if (!existsSync(resolve(root, "dist/web/index.js"))) {
  process.stderr.write("t20 harness requires a fresh `npm run build` first\n");
  process.exit(2);
}

if (!acquireLock()) {
  process.stderr.write(`t20 harness could not acquire ${LOCK_PATH}\n`);
  process.exit(1);
}
const scenarioFilter = process.argv[2];
const onlyScenarios =
  scenarioFilter === undefined ? undefined : new Set(scenarioFilter.split(",").filter((id) => id.length > 0));

try {
  const first = runPass(onlyScenarios);
  const second = runPass(onlyScenarios);
  const sameInventory =
    first.projections.length === second.projections.length &&
    first.projections.every((entry, index) => entry.id === second.projections[index]?.id) &&
    first.projections.every(
      (entry, index) => entry.sha === second.projections[index]?.sha,
    );
  const sameDigest = first.digest === second.digest;
  const expectedCount = onlyScenarios?.size ?? 22;
  const pass =
    first.failures === 0 &&
    second.failures === 0 &&
    sameInventory &&
    sameDigest &&
    first.projections.length === expectedCount;
  const result = {
    suite: "t20-web-tools",
    scenarios: first.projections.length,
    failures: first.failures + second.failures,
    pass,
    digest: first.digest,
    secondDigest: second.digest,
    digestFormula:
      "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included; contract T20 ids only)",
    projections: first.projections,
  };
  writeFileSync(resolve(evidenceDirectory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = pass ? 0 : 1;
} finally {
  releaseLock();
}
