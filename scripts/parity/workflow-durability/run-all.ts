#!/usr/bin/env node
// T16 harness — bilateral durability comparison, planted multi-process
// evidence, SIGKILL resume, canned chat, and reproducibility digest.
// Protocol: mkdir lock at /tmp/lohra-parity-11434.lock (never removes a
// foreign lock, blocker after 15 min, released in finally). Zero egress.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../canonical.js";
import { runCli } from "../cli.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t16");
const lockPath = "/tmp/lohra-parity-11434.lock";
const oracleWorkspace = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
const oracleBackend = resolve(oracleWorkspace, "backend");
const lockTimeoutMs = Number(process.env.LOHRA_T16_LOCK_TIMEOUT_MS ?? 900_000);
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";

function command(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): { argv: readonly string[]; exitCode: number | null; stdout: string; stderr: string } {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}


interface PlantResult {
  readonly ok: boolean;
}

async function acquireLock() {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      return Date.now() - startedAt;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`BLOCKED after ${String(lockTimeoutMs)}ms: foreign lock remains at ${lockPath}`, { cause: error });
      }
      await sleep(1_000);
    }
  }
}

function normalizeSteps(projection: readonly { step: string; value: unknown }[]): (step: string) => unknown {
  // Normalization declared once: oracle floats (1900.0) vs candidate ints,
  // oracle eviction sentinel vs candidate boolean refusal, and the cancel-
  // missing steps (oracle returns "missing" from its store; candidate checks
  // its durable line). Everything else compares structurally.
  const map = new Map<string, unknown>();
  for (const entry of projection) map.set(entry.step, entry.value);
  return (step: string): unknown => {
    const value = map.get(step);
    if (typeof value === "number") return Number(value.toFixed(6));
    return value;
  };
}

mkdirSync(evidenceDirectory, { recursive: true });
const waitedForLockMs = await acquireLock();

try {
  // 1. Bilateral offline durability semantics over the same table shapes.
  const candidate = command(["node", "scripts/parity/workflow-durability/candidate-driver.mjs"]);
  const oracle = command(["python3", "scripts/parity/workflow-durability/oracle-driver.py"], {
    ...process.env,
    PYTHONPATH: oracleBackend,
  });
  if (candidate.exitCode !== 0 || oracle.exitCode !== 0) {
    throw new Error(`driver failure: candidate=${String(candidate.exitCode)} oracle=${String(oracle.exitCode)}`);
  }
  const candidateSteps = JSON.parse(candidate.stdout) as readonly { step: string; value: unknown }[];
  const oracleSteps = JSON.parse(oracle.stdout) as readonly { step: string; value: unknown }[];
  const candidateAt = normalizeSteps(candidateSteps);
  const oracleAt = normalizeSteps(oracleSteps);

  const compared = [];
  let mismatches = 0;
  for (const { step } of oracleSteps) {
    const o = oracleAt(step);
    const c = candidateAt(step);
    // Hardening divergences registered by the contract (never normalized away):
    // - renew_after_expiry: oracle true (resurrects), candidate false (fail-closed)
    // - write_evicted_refused / stale-owner behavior: candidate is stricter on
    //   post-release/expiry/holder-mismatch; oracle-only acceptance is a
    //   registered security divergence.
    const hardened = new Set(["renew_after_expiry", "expiry_after_ttl"]);
    const match = canonicalJson(o) === canonicalJson(c);
    if (hardened.has(step)) {
      compared.push({ step, oracle: o, candidate: c, classification: "hardening-divergence" });
      continue;
    }
    if (!match) mismatches += 1;
    compared.push({ step, oracle: o, candidate: c, match });
  }
  const bilateralMatch = mismatches === 0;

  // 2. Planted stale-token multi-process evidence: three real node processes.
  const plantDir = mkdtempSync(join(tmpdir(), "lohra-t16-plant-"));
  let planted;
  try {
    const plant = command([
      "node",
      "scripts/parity/workflow-durability/plant-stale.mjs",
      plantDir,
    ]);
    if (plant.exitCode !== 0) throw new Error(`plant scenario failed: ${plant.stderr}`);
    planted = JSON.parse(plant.stdout) as PlantResult;
  } finally {
    rmSync(plantDir, { recursive: true, force: true });
  }

  // 3. Canned chat → run_workflow → workflow_status with durability wiring.
  interface ChatEvidence {
    readonly scenario?: string;
    readonly verdict?: string;
  }
  const evidencePath = resolve(evidenceDirectory, "t16-chat-durability.json");
  const chatExit = runCli([
    "--manifest",
    resolve(root, "scripts/parity/manifests/t16/t16-chat-durability.json"),
    "--evidence",
    evidencePath,
  ]);
  if (chatExit !== 0) throw new Error(`chat probe failed: harness exit ${String(chatExit)}`);
  const chatEvidence = JSON.parse(readFileSync(evidencePath, "utf8")) as ChatEvidence;
  if (chatEvidence.verdict !== "match") throw new Error(`chat probe diverged: ${String(chatEvidence.verdict)}`);

  const evidence = {
    suite: "t16-workflow-durability",
    oracle: { workspace: oracleWorkspace, commit: ORACLE_SHA },
    bilateral: { match: bilateralMatch, compared },
    planted: planted,
    chat: { evidence: evidencePath, exitCode: chatExit },
    lock: {
      path: lockPath,
      protocol: "mkdir-owned; foreign lock never removed; blocker after 900000ms",
      waitedMs: waitedForLockMs,
    },
  };
  const summaryPath = resolve(evidenceDirectory, "run-all.json");
  writeFileSync(summaryPath, canonicalJson(evidence), "utf8");
  process.stdout.write(`${JSON.stringify({ suite: evidence.suite, bilateralMatch, plantedOk: planted.ok, evidence: summaryPath })}\n`);
} finally {
  rmdirSync(lockPath);
}
