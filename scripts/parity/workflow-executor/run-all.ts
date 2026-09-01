#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "../canonical.js";
import { runCli } from "../cli.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t15");
const lockPath = "/tmp/lohra-parity-11434.lock";
const oracleWorkspace =
  "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
const oracleBackend = resolve(oracleWorkspace, "backend");
const lockTimeoutMs = Number(process.env.LOHRA_T15_LOCK_TIMEOUT_MS ?? 900_000);

interface CommandRecord {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function command(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): CommandRecord {
  const [executable, ...args] = argv;
  if (executable === undefined) throw new Error("empty command");
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return {
    argv,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function acquireLock(): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      return Date.now() - startedAt;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
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

mkdirSync(evidenceDirectory, { recursive: true });
const waitedForLockMs = await acquireLock();

try {
  const candidate = command(["node", "scripts/parity/workflow-executor/candidate-engine.mjs"]);
  const oracle = command(
    ["python3", "scripts/parity/workflow-executor/oracle_engine.py"],
    { ...process.env, PYTHONPATH: oracleBackend },
  );
  if (candidate.exitCode !== 0 || oracle.exitCode !== 0) {
    throw new Error(
      `engine probe failed: candidate=${String(candidate.exitCode)} oracle=${String(oracle.exitCode)}`,
    );
  }

  const candidateProjection = JSON.parse(candidate.stdout) as unknown;
  const oracleProjection = JSON.parse(oracle.stdout) as unknown;
  const engineMatch = canonicalJson(candidateProjection) === canonicalJson(oracleProjection);
  if (!engineMatch) throw new Error("bilateral engine projections diverged");

  const chatEvidence = resolve(evidenceDirectory, "t15-chat-workflow.json");
  const chatExitCode = runCli([
    "--manifest",
    resolve(root, "scripts/parity/manifests/t15/t15-chat-workflow.json"),
    "--evidence",
    chatEvidence,
  ]);
  const chat = JSON.parse(readFileSync(chatEvidence, "utf8")) as {
    readonly verdict?: string;
    readonly reproducibility?: { readonly projectionSha256?: string };
  };
  const chatMatch = chatExitCode === 0 && chat.verdict === "match";
  if (!chatMatch) throw new Error(`real chat probe diverged with exit ${String(chatExitCode)}`);

  const evidence = {
    suite: "t15-workflow-executor",
    engine: {
      match: engineMatch,
      candidate: candidateProjection,
      oracle: oracleProjection,
      candidateStderr: candidate.stderr,
      oracleStderr: oracle.stderr,
    },
    chat: {
      match: chatMatch,
      evidence: chatEvidence,
      projectionSha256: chat.reproducibility?.projectionSha256 ?? null,
    },
    lock: {
      path: lockPath,
      protocol: "mkdir-owned; foreign lock never removed; blocker after 900000ms",
      waitedMs: waitedForLockMs,
    },
    oracle: {
      workspace: oracleWorkspace,
      commit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
    },
  };
  const summaryPath = resolve(evidenceDirectory, "run-all.json");
  writeFileSync(summaryPath, canonicalJson(evidence), "utf8");
  process.stdout.write(
    `${JSON.stringify({ suite: evidence.suite, engineMatch, chatMatch, evidence: summaryPath })}\n`,
  );
} finally {
  rmdirSync(lockPath);
}
