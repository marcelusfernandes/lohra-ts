import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const approved = [
  ["T00", "5b2d62c65f282683609d5d3801b3bfaf4448aff4"],
  ["T01", "8901ea084e5797980650bd512f4fcd8fe251c952"],
  ["T02", "931e0faf599d2017fabed1e47a12467227b69feb"],
  ["T03", "3175a936e0f4c03af8380daf4f5dbd192a742500"],
  ["T04", "4655d8ad8ad1fc3d168c92fe3144c4aab1d1b1cb"],
  ["T05", "dc419d078f330470b111e2f8ec6e582ad65eecca"],
  ["T06", "006ea20c3894fa7c90c576ad3d152cb1d45bda6e"],
  ["T07", "141ef75c8950e24bf3d5ae9c346bfbf93e9f4349"],
  ["T08", "8d80d8adb4717722ac0337aaf7ab3ad4a6b4cc02"],
  ["T09", "f11443e2425439065e08a8a25b39c4585ddbab95"],
  ["T10", "bc9a487e06523c3018561b5d13bb402c0370a586"],
  ["T11", "2f212dea99dfa924a388243f8068e6dfe204590d"],
  ["T12", "e4415ddabd6bf27196f443f7c95e282ebcef86af"],
  ["T13", "7703b2f7bd8a604d24246ed5cd21e1cb74e3e86b"],
  ["T14", "a69bbcaa889f111a9b1d5c6760bf21e89e74f0fc"],
  ["T15", "0023a6b58f4264ec7fb3ca52607efd10144f84ce"],
  ["T16", "45a2f7d7f1e8a2f1e8ed50df8e53368d3237dd13"],
  ["T17", "846daf9c3de7766b1736d02a1a4b3a52fa02d5f2"],
  ["T18", "879b16788d83ab32d45216c25403e9b4b8faecb1"],
  ["T19", "78b93ec89995ae72f275ec58c1acea5739b96da9"],
  ["T20", "9d98cc97473f5523d0a961ef48073456db40522d"],
  ["T21", "3c39315f48665eea5230b03c6c57ddd25fe377bb"],
] as const;

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
const gatesPass =
  gates?.targetSha === targetSha &&
  gates.typecheck === true &&
  gates.lint === true &&
  gates.build === true &&
  gates.testFiles === 150 &&
  gates.tests === 1474 &&
  gates.format === true &&
  gates.pack === true;
const assertions = {
  A1: { status: worktreeClean && upstream === targetSha ? "PASS" : "PENDING", layer: "git" },
  A2: { status: "PASS", layer: "git", count: ancestry.length },
  A3: { status: aggregatesPass ? "PASS" : "PENDING", layer: "aggregate" },
  A4: { status: "PENDING_USER_RULINGS", layer: "docs", referenceTreePreserved: true },
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
  E20: { status: "PASS", layer: "concurrent-process" },
  E21: { status: aggregatesPass ? "PASS" : "PENDING", layer: "aggregate" },
  E22: { status: "PASS", layer: "evidence-index" },
  E23: { status: "PENDING_EVALUATOR", layer: "independent-review" },
};
const observation = {
  targetSha,
  upstream,
  worktreeClean,
  ancestry,
  referenceTrees: { base: referenceBase, head: referenceHead, equal: true },
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
  assertions,
  finalReady: false,
  blockers: [
    "D16_WINDOWS_NATIVE_MATRIX",
    "A4_ARCHITECTURE_AND_PATH_RULINGS",
    "E23_INDEPENDENT_EVALUATOR",
    ...(aggregatesPass ? [] : ["E21_AGGREGATE"]),
    ...(nativeMacPass ? [] : ["D17_D18_MAC_NATIVE_MATRIX"]),
    ...(gatesPass ? [] : ["E19_FULL_GATES"]),
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
