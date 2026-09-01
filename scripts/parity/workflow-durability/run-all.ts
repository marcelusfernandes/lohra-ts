#!/usr/bin/env node
// T16 harness — bilateral durability comparison, planted multi-process
// evidence, SIGKILL resume, canned chat, and a REPRODUCIBLE evidence record.
// Protocol: mkdir lock at /tmp/lohra-parity-11434.lock (never removes a
// foreign lock, blocker after 15 min, released in finally). Zero egress.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { canonicalJson } from "../canonical.js";
import { runCli } from "../cli.js";
import { resolveExecutable, resolveOracleWorkspace } from "../resolve.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t16");
const lockPath = "/tmp/lohra-parity-11434.lock";
const lockTimeoutMs = Number(process.env.LOHRA_T16_LOCK_TIMEOUT_MS ?? 900_000);
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";

// The oracle Python is the SANCTIONED `.oracle-venv/bin/python`, discovered
// exactly as the manifest runners discover it — never the system interpreter,
// whose importable packages depend on whoever's shell is running the gate.
const oracleWorkspace = resolveOracleWorkspace({
  cwd: root,
  timeoutMs: 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
});
const oraclePython = resolveExecutable("oracle-python", { oracle: oracleWorkspace });
const oracleBackend = resolve(oracleWorkspace.repository, "backend");

function command(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { argv: readonly string[]; exitCode: number | null; stdout: string; stderr: string } {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error("empty command");
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { argv, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("/usr/bin/git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return result.stdout.trim();
}

/** The candidate is the COMMITTED SHA under test: the record names it, and a
 * dirty worktree means the evidence describes something nobody can check out. */
function candidateGuard(): { sha: string; porcelain: string } {
  const sha = git(root, ["rev-parse", "HEAD"]);
  const porcelain = git(root, ["status", "--porcelain"]);
  if (porcelain !== "")
    throw new Error(`candidate worktree is dirty; evidence would not be reproducible:\n${porcelain}`);
  return { sha, porcelain };
}

/** The oracle is read-only at a pinned SHA: assert it, never assume it. */
function oracleGuard(): { commit: string; porcelain: string; pinned: boolean } {
  const commit = git(oracleWorkspace.repository, ["rev-parse", "HEAD"]);
  const porcelain = git(oracleWorkspace.repository, ["status", "--porcelain"]);
  if (commit !== ORACLE_SHA) throw new Error(`oracle HEAD is ${commit}, expected ${ORACLE_SHA}`);
  if (porcelain !== "") throw new Error(`oracle worktree is dirty:\n${porcelain}`);
  return { commit, porcelain, pinned: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface PlantResult {
  readonly ok: boolean;
}

async function acquireLock(): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      return Date.now() - startedAt;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(
          `BLOCKED after ${String(lockTimeoutMs)}ms: foreign lock remains at ${lockPath}`,
          { cause: error },
        );
      }
      await sleep(1_000);
    }
  }
}

function normalizeSteps(
  projection: readonly { step: string; value: unknown }[],
): (step: string) => unknown {
  // Normalization declared once: oracle floats (1900.0) vs candidate ints.
  // Everything else compares structurally; security divergences are REGISTERED
  // below with their expected values, never normalized into a match.
  const map = new Map<string, unknown>();
  for (const entry of projection) map.set(entry.step, entry.value);
  return (step: string): unknown => {
    const value = map.get(step);
    if (typeof value === "number") return Number(value.toFixed(6));
    return value;
  };
}

/**
 * Hardening divergences (contract H1/H2). Each names the exact value each side
 * must produce: a step that stopped diverging — or diverged differently — is a
 * red run, not a silent pass.
 */
const HARDENING: Readonly<Record<string, { oracle: unknown; candidate: unknown; rule: string }>> = {
  renew_after_expiry: {
    oracle: true,
    candidate: false,
    rule: "H2: the oracle's renew has no validity predicate, so an old holder resurrects an expired lease; the candidate demands expires_at > now in the same statement",
  },
  expiry_after_ttl: {
    oracle: 2801,
    candidate: null,
    rule: "H2 consequence: the oracle's resurrected lease reads a fresh expiry (1901+900); the candidate's expired lease stays expired",
  },
  h1_write_post_release: {
    oracle: true,
    candidate: false,
    rule: "H1: the oracle accepts an owned write presented after its own release with the same fence; the candidate demands a LIVE lease held by that holder",
  },
  h1_status_after: {
    oracle: "complete",
    candidate: "running",
    rule: "H1 consequence: the oracle's post-release write landed, the candidate's did not",
  },
};

mkdirSync(evidenceDirectory, { recursive: true });
const candidateBefore = candidateGuard();
const oracleBefore = oracleGuard();
const waitedForLockMs = await acquireLock();

try {
  // 1. Bilateral offline durability semantics over the same table shapes.
  const candidate = command(["node", "scripts/parity/workflow-durability/candidate-driver.mjs"]);
  const oracle = command([oraclePython, "scripts/parity/workflow-durability/oracle-driver.py"], {
    ...process.env,
    PYTHONPATH: oracleBackend,
    PYTHONHASHSEED: "0",
    PYTHONUTF8: "1",
    TZ: "UTC",
  });
  if (candidate.exitCode !== 0 || oracle.exitCode !== 0) {
    throw new Error(
      `driver failure: candidate=${String(candidate.exitCode)} oracle=${String(oracle.exitCode)}\n` +
        `candidate stderr: ${candidate.stderr}\noracle stderr: ${oracle.stderr}`,
    );
  }
  const candidateSteps = JSON.parse(candidate.stdout) as readonly { step: string; value: unknown }[];
  const oracleSteps = JSON.parse(oracle.stdout) as readonly { step: string; value: unknown }[];
  const candidateAt = normalizeSteps(candidateSteps);
  const oracleAt = normalizeSteps(oracleSteps);

  const compared = [];
  let mismatches = 0;
  let divergenceFailures = 0;
  for (const { step } of oracleSteps) {
    const o = oracleAt(step);
    const c = candidateAt(step);
    const registered = HARDENING[step];
    if (registered !== undefined) {
      const held =
        canonicalJson(o) === canonicalJson(registered.oracle) &&
        canonicalJson(c) === canonicalJson(registered.candidate);
      if (!held) divergenceFailures += 1;
      compared.push({
        step,
        oracle: o,
        candidate: c,
        classification: "hardening-divergence",
        rule: registered.rule,
        held,
      });
      continue;
    }
    const match = canonicalJson(o) === canonicalJson(c);
    if (!match) mismatches += 1;
    compared.push({ step, oracle: o, candidate: c, match });
  }
  if (divergenceFailures > 0) {
    throw new Error(`${String(divergenceFailures)} registered hardening divergence(s) no longer hold`);
  }
  const bilateralMatch = mismatches === 0;

  // 2. Planted multi-process evidence: real concurrent processes, one barrier
  //    race, a live owner with concurrent writers, and a SIGKILL + cold resume.
  const plantDir = mkdtempSync(join(tmpdir(), "lohra-t16-plant-"));
  let planted: PlantResult;
  try {
    const plant = command([
      "node",
      "scripts/parity/workflow-durability/plant-stale.mjs",
      plantDir,
    ]);
    if (plant.exitCode !== 0) throw new Error(`plant scenario failed: ${plant.stderr}`);
    planted = JSON.parse(plant.stdout) as PlantResult;
    if (!planted.ok) throw new Error(`plant scenario red: ${plant.stdout}`);
  } finally {
    rmSync(plantDir, { recursive: true, force: true });
  }

  // 3. Canned chat → run_workflow → workflow_status with durability wiring,
  //    plus the cold-resume variant that crosses a process boundary.
  interface ChatEvidence {
    readonly scenario?: string;
    readonly verdict?: string;
  }
  const chats = ["t16-chat-durability", "t16-chat-cold-resume"].map((id) => {
    const evidencePath = resolve(evidenceDirectory, `${id}.json`);
    const exitCode = runCli([
      "--manifest",
      resolve(root, `scripts/parity/manifests/t16/${id}.json`),
      "--evidence",
      evidencePath,
    ]);
    if (exitCode !== 0) throw new Error(`chat probe ${id} failed: harness exit ${String(exitCode)}`);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as ChatEvidence;
    if (evidence.verdict !== "match")
      throw new Error(`chat probe ${id} diverged: ${evidence.verdict ?? "missing"}`);
    return { id, evidence: evidencePath, verdict: evidence.verdict, exitCode };
  });

  const oracleAfter = oracleGuard();
  const candidateAfter = candidateGuard();
  const evidence = {
    suite: "t16-workflow-durability",
    candidate: {
      targetSha: candidateBefore.sha,
      guard: { before: candidateBefore, after: candidateAfter },
    },
    oracle: {
      workspace: oracleWorkspace.repository,
      python: oraclePython.slice(oraclePython.indexOf(".oracle-venv")),
      commit: ORACLE_SHA,
      guard: { before: oracleBefore, after: oracleAfter },
    },
    bilateral: { match: bilateralMatch, compared },
    planted,
    chat: chats,
    lock: {
      path: lockPath,
      protocol: "mkdir-owned; foreign lock never removed; blocker after 900000ms",
    },
  };
  const summaryPath = resolve(evidenceDirectory, "run-all.json");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, canonicalJson(evidence), "utf8");
  process.stdout.write(
    `${JSON.stringify({
      suite: evidence.suite,
      targetSha: candidateBefore.sha,
      bilateralMatch,
      plantedOk: planted.ok,
      chats: chats.map((chat) => `${chat.id}=${chat.verdict}`),
      waitedForLockMs,
      evidence: summaryPath,
    })}\n`,
  );
} finally {
  rmdirSync(lockPath);
}
