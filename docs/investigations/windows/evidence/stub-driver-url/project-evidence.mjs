import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, baseSha, codeSha] = process.argv.slice(2);
if (!root || !baseSha || !codeSha) {
  throw new Error("usage: node project-evidence.mjs <external-root> <base-sha> <code-sha>");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function project(report) {
  const counts = {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
  };
  if (counts.passed + counts.failed + counts.pending !== counts.total) {
    throw new Error("Vitest assertion counts do not reconcile");
  }
  return {
    counts,
    failures: report.testResults.flatMap((file) =>
      file.assertionResults
        .filter((assertion) => assertion.status === "failed")
        .map((assertion) => {
          const message = assertion.failureMessages.join("\n");
          return {
            name: assertion.fullName,
            causeCode: message.includes("ERR_MODULE_NOT_FOUND") ? "ERR_MODULE_NOT_FOUND" : null,
            observedStatus: /expected 1 to be (?:88|\+0)/.test(message) ? 1 : null,
          };
        }),
    ),
  };
}

for (const version of ["20", "22"]) {
  const basePath = join(root, `base${version}.json`);
  const greenPath = join(root, `green${version}.json`);
  const proofPath = join(
    root,
    `node ${version} checkout`,
    ".prova",
    "windows-stub-driver-url",
    "resumo.json",
  );
  const base = project(readJson(basePath));
  const green = project(readJson(greenPath));
  const proof = readJson(proofPath);
  if (
    base.counts.total !== 4 ||
    base.counts.failed !== 3 ||
    base.failures.some(
      (failure) => failure.causeCode !== "ERR_MODULE_NOT_FOUND" || failure.observedStatus !== 1,
    ) ||
    green.counts.total !== 4 ||
    green.counts.failed !== 0 ||
    proof.ok !== true ||
    proof.total !== 4 ||
    proof.falhas.length !== 0
  ) {
    throw new Error(`unexpected before/after result for Node ${version}`);
  }
  writeFileSync(
    new URL(`./node${version}.json`, import.meta.url),
    `${JSON.stringify(
      {
        schema: 1,
        node: version === "20" ? "20.20.2" : "22.23.2",
        base: { sha: baseSha, exit: 1, reporterSha256: sha256(basePath), ...base },
        candidate: {
          codeSha,
          exit: 0,
          reporterSha256: sha256(greenPath),
          ...green,
          proof: { exit: 0, ok: proof.ok, total: proof.total, failed: proof.falhas.length },
          proofSha256: sha256(proofPath),
        },
      },
      null,
      2,
    )}\n`,
  );
}
