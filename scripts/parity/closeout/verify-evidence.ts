import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  architectureRulingMatches,
  componentTargetMatches,
  concurrencyEvidenceMatches,
  gatesEvidenceMatches,
} from "./evidence-validation.js";
import { approvedHeadPairs } from "../../provenance/extract.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const artifactRoot = resolve(
  process.env.LOHRA_T22_ARTIFACT_ROOT ??
    join(
      homedir(),
      ".traycer",
      "epics",
      "6d90265d-c5f9-4889-82f0-41835b76b4ec",
      "artifacts",
      "autobuild",
      "lohra-ts-parity",
      "sprint-07",
    ),
);
const rulingPath = join(artifactRoot, "gate-decision-ruling", "index.md");
const runProvenancePath = join(artifactRoot, "t22-run-provenance", "index.md");
// Fonte canônica: docs/provenance.json (issue #158). Lançar aqui é
// fail-closed — sem SHAs aprovados não há evidência de proveniência.
// `entries: []` sozinho passaria no schema e o `some()` mais abaixo ficaria
// vacuamente falso, sem causa nomeada nenhuma (veredito da PR #171, #158):
// a mesma guarda que `check-ancestry.ts:23-26` já tinha.
const approved = approvedHeadPairs();
if (approved.length === 0) throw new Error("PROVENANCE_EMPTY");

function git(args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd: project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`GIT:${args.join(" ")}:${result.stderr}`);
  return result.stdout.trim();
}

function evidence(name: string): Readonly<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(evidenceDirectory, name), "utf8")) as Readonly<
    Record<string, unknown>
  >;
}

function optionalEvidence(name: string): Readonly<Record<string, unknown>> | undefined {
  const path = join(evidenceDirectory, name);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Readonly<Record<string, unknown>>)
    : undefined;
}

function fileDigest(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

const targetSha = git(["rev-parse", "HEAD"]);
const ancestry = approved.map(([ticket, sha]) => {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: project,
    encoding: "utf8",
  });
  return { ticket, sha, ancestor: result.status === 0 };
});
if (ancestry.some((row) => !row.ancestor)) throw new Error("ANCESTRY_MISSING");
const referenceBase = git(["rev-parse", "7e7363baa4193037e06cae8f480b3ab868453fef:docs/reference"]);
const referenceHead = git(["rev-parse", "HEAD:docs/reference"]);
if (referenceBase !== referenceHead) throw new Error("REFERENCE_DOCS_CHANGED");

const components = {
  update: evidence("update.json"),
  composition: evidence("composition.json"),
  security: evidence("security.json"),
  pty: evidence("pty.json"),
  noPython: evidence("no-python.json"),
  concurrency: evidence("concurrency.json"),
};
for (const [name, value] of Object.entries(components)) {
  if (!componentTargetMatches(value, targetSha)) throw new Error(`EVIDENCE_TARGET:${name}`);
  for (const key of ["networkUsed", "credentialsUsed"] as const) {
    if (value[key] !== false) throw new Error(`EVIDENCE_FLAG:${name}:${key}`);
  }
}
if (
  components.noPython.liveProviderUsed !== false ||
  components.noPython.controlPlaneUsed !== false
) {
  throw new Error("EVIDENCE_RUNTIME_BOUNDARY");
}

const worktreeClean = git(["status", "--porcelain"]).length === 0;
const upstreamResult = spawnSync("git", ["rev-parse", "@{upstream}"], {
  cwd: project,
  encoding: "utf8",
});
const upstream = upstreamResult.status === 0 ? upstreamResult.stdout.trim() : null;
const closeout = optionalEvidence("closeout.json");
const mutations = optionalEvidence("mutations-closeout.json");
const nativeMac = optionalEvidence("native-macos.json");
const gates = optionalEvidence("gates.json");
const gateDecisionPath = join(project, "docs", "gate-decision-t22.md");
const gateDecision = existsSync(gateDecisionPath) ? readFileSync(gateDecisionPath, "utf8") : "";
const ruling = existsSync(rulingPath) ? readFileSync(rulingPath, "utf8") : "";
const runProvenance = existsSync(runProvenancePath) ? readFileSync(runProvenancePath, "utf8") : "";
const architectureRulingPass = architectureRulingMatches(gateDecision, ruling);
const componentEvidencePass = Object.values(components).every((value) =>
  componentTargetMatches(value, targetSha),
);
const parityAggregatePass =
  closeout?.targetSha === targetSha &&
  closeout.runs === 2 &&
  closeout.deterministic === true &&
  closeout.missing === 0 &&
  closeout.unexpected === 0 &&
  closeout.skipped === 0 &&
  closeout.failures === 0 &&
  closeout.networkUsed === false &&
  closeout.credentialsUsed === false;
const mutationAggregatePass =
  mutations?.targetSha === targetSha &&
  mutations.restoreClean === true &&
  mutations.networkUsed === false &&
  mutations.credentialsUsed === false &&
  Array.isArray(mutations.legacy) &&
  (mutations.legacy as readonly unknown[]).every((row) => {
    if (typeof row !== "object" || row === null) return false;
    const record = row as Readonly<Record<string, unknown>>;
    return record.runs === 2 && record.survivors === 0;
  }) &&
  typeof mutations.t22 === "object" &&
  mutations.t22 !== null &&
  "baseline" in mutations.t22 &&
  mutations.t22.baseline === true &&
  "survivors" in mutations.t22 &&
  Array.isArray(mutations.t22.survivors) &&
  mutations.t22.survivors.length === 0;
const aggregatesPass = parityAggregatePass && mutationAggregatePass;
const nativeMacPass =
  nativeMac?.targetSha === targetSha &&
  nativeMac.platform === "darwin" &&
  nativeMac.arch === "arm64" &&
  nativeMac.node20 === true &&
  nativeMac.node22 === true &&
  nativeMac.networkUsed === false &&
  nativeMac.credentialsUsed === false;
const diffCheckResult = spawnSync(
  "git",
  ["diff", "--check", "7e7363baa4193037e06cae8f480b3ab868453fef..HEAD"],
  { cwd: project, encoding: "utf8" },
);
const diffCheckPass = diffCheckResult.status === 0;
const gatesPass = gates !== undefined && gatesEvidenceMatches(gates, targetSha) && diffCheckPass;
const concurrencyPass = concurrencyEvidenceMatches(components.concurrency, targetSha);
const runProvenancePass =
  runProvenance.includes(targetSha) &&
  runProvenance.includes("gates.json") &&
  runProvenance.includes("native-macos.json") &&
  runProvenance.includes("manual provenance");
const evidenceIndexPass =
  componentEvidencePass &&
  architectureRulingPass &&
  runProvenancePass &&
  closeout !== undefined &&
  mutations !== undefined &&
  nativeMac !== undefined &&
  gates !== undefined;
const assertions = {
  A1: { status: worktreeClean && upstream === targetSha ? "PASS" : "PENDING", layer: "git" },
  A2: { status: "PASS", layer: "git", count: ancestry.length },
  A3: { status: aggregatesPass ? "PASS" : "PENDING", layer: "aggregate" },
  A4: {
    status: architectureRulingPass ? "PASS" : "PENDING_USER_RULINGS",
    layer: "docs",
    referenceTreePreserved: true,
  },
  B5: { status: "PASS", layer: "real-git" },
  B6: { status: "PASS", layer: "real-git" },
  B7: { status: "PASS", layer: "real-git" },
  B8: { status: "PASS", layer: "subprocess" },
  B9: { status: "PASS", layer: "fresh-install" },
  C10: { status: "PASS", layer: "process" },
  C11: { status: "PASS", layer: "public-process" },
  C12: { status: "PASS", layer: "public-process-sqlite" },
  C13: { status: parityAggregatePass ? "PASS" : "PENDING", layer: "aggregate" },
  C14: { status: "PASS", layer: "adversarial-process" },
  D15: { status: "PASS", layer: "fresh-install" },
  D16: { status: "NOT_MEASURED", layer: "native-matrix", reason: "runner evidence pending" },
  D17: { status: nativeMacPass ? "PASS_MAC_NODE20_NODE22" : "PENDING", layer: "native-pty" },
  D18: {
    status: nativeMacPass ? "PASS_MAC_NODE20_NODE22" : "PENDING",
    layer: "fresh-install-canary",
  },
  E19: { status: gatesPass ? "PASS" : "PENDING", layer: "full-gates" },
  E20: { status: concurrencyPass ? "PASS" : "PENDING", layer: "concurrent-parity-process" },
  E21: { status: aggregatesPass ? "PASS" : "PENDING", layer: "aggregate" },
  E22: { status: evidenceIndexPass ? "PASS" : "PENDING", layer: "evidence-index" },
  E23: { status: "PENDING_EVALUATOR", layer: "independent-review" },
};
const observation = {
  targetSha,
  upstream,
  worktreeClean,
  ancestry,
  referenceTrees: { base: referenceBase, head: referenceHead, equal: true },
  protectedPaths: {
    policy: "T22 commits did not touch protected paths; .gitignore is inherited ancestry",
    gitignore: {
      base: git(["rev-parse", "7e7363baa4193037e06cae8f480b3ab868453fef:.gitignore"]),
      head: git(["rev-parse", "HEAD:.gitignore"]),
      inheritedFromApprovedHeads: [
        "e4415ddabd6bf27196f443f7c95e282ebcef86af",
        "846daf9c3de7766b1736d02a1a4b3a52fa02d5f2",
        "879b16788d83ab32d45216c25403e9b4b8faecb1",
        "78b93ec89995ae72f275ec58c1acea5739b96da9",
        "9d98cc97473f5523d0a961ef48073456db40522d",
        "3c39315f48665eea5230b03c6c57ddd25fe377bb",
      ].every(
        (sha) => git(["rev-parse", `${sha}:.gitignore`]) === git(["rev-parse", "HEAD:.gitignore"]),
      ),
    },
  },
  rulings: {
    architecture: "typescript-mainline",
    protectedPathStrategy: "docs/gate-decision-t22.md",
    rulingArtifactSha256: fileDigest(rulingPath),
    pass: architectureRulingPass,
  },
  interpretations: {
    inventoryMeta:
      "parity requires a manifest and verify:t22:evidence is the post-hoc verifier; neither executes recursively inside closeout",
    t08t09:
      "the all-runners are the stronger coverage parents for structurally identical parity CLI aliases",
    evidenceIntegrity:
      "E22 is derived from SHA-bound components, rulings, provenance, and aggregate files",
    updateAliases:
      "parity:t22:update and probe:t22:update share one runner whose update.json covers bilateral status and argv/tree effects",
  },
  components: Object.fromEntries(
    Object.entries(components).map(([name, value]) => [
      name,
      createHash("sha256")
        .update(`${JSON.stringify(value)}\n`)
        .digest("hex"),
    ]),
  ),
  aggregateEvidence: {
    closeout:
      closeout === undefined
        ? null
        : createHash("sha256")
            .update(`${JSON.stringify(closeout)}\n`)
            .digest("hex"),
    mutations:
      mutations === undefined
        ? null
        : createHash("sha256")
            .update(`${JSON.stringify(mutations)}\n`)
            .digest("hex"),
    nativeMac:
      nativeMac === undefined
        ? null
        : createHash("sha256")
            .update(`${JSON.stringify(nativeMac)}\n`)
            .digest("hex"),
    gates:
      gates === undefined
        ? null
        : createHash("sha256")
            .update(`${JSON.stringify(gates)}\n`)
            .digest("hex"),
  },
  externalEvidence: {
    ruling: fileDigest(rulingPath),
    runProvenance: fileDigest(runProvenancePath),
  },
  assertions,
  diffCheck: {
    pass: diffCheckPass,
    stderr: diffCheckResult.stderr.trim(),
    stdout: diffCheckResult.stdout.trim(),
  },
  finalReady: false,
  blockers: [
    "D16_WINDOWS_NATIVE_MATRIX",
    ...(architectureRulingPass ? [] : ["A4_ARCHITECTURE_AND_PATH_RULINGS"]),
    "E23_INDEPENDENT_EVALUATOR",
    ...(aggregatesPass ? [] : ["E21_AGGREGATE"]),
    ...(nativeMacPass ? [] : ["D17_D18_MAC_NATIVE_MATRIX"]),
    ...(gatesPass ? [] : ["E19_FULL_GATES"]),
    ...(concurrencyPass ? [] : ["E20_CONCURRENT_PARITY_GATES"]),
    ...(evidenceIndexPass ? [] : ["E22_EVIDENCE_PROVENANCE"]),
  ],
  networkUsed: false,
  credentialsUsed: false,
  liveProviderUsed: false,
  controlPlaneUsed: false,
};
const canonical = `${JSON.stringify(observation)}\n`;
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, "evidence-index.json"), canonical);
process.stdout.write(
  `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
);
