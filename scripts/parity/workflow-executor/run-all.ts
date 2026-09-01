#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
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

  interface ChatEvidence {
    readonly verdict?: string;
    readonly comparison?: {
      readonly normalized?: Readonly<Record<string, { readonly oracle: unknown; readonly candidate: unknown }>>;
    };
    readonly reproducibility?: { readonly projectionSha256?: string };
  }

  const runChatProbe = (evidenceFileName: string) => {
    const evidencePath = resolve(evidenceDirectory, evidenceFileName);
    const exitCode = runCli([
      "--manifest",
      resolve(root, "scripts/parity/manifests/t15/t15-chat-workflow.json"),
      "--evidence",
      evidencePath,
    ]);
    if (exitCode !== 0)
      throw new Error(`${evidenceFileName} chat probe failed with harness exit ${String(exitCode)}`);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as ChatEvidence;
    if (evidence.verdict !== "match")
      throw new Error(`${evidenceFileName} chat probe diverged: verdict=${evidence.verdict ?? "unavailable"}`);
    return { evidencePath, evidence };
  };

  const chatPrimary = runChatProbe("t15-chat-workflow.json");
  const chatRepeat = runChatProbe("t15-chat-workflow-repeat.json");
  const primarySha = chatPrimary.evidence.reproducibility?.projectionSha256 ?? null;
  const repeatSha = chatRepeat.evidence.reproducibility?.projectionSha256 ?? null;
  const chatHashStable = primarySha !== null && primarySha === repeatSha;
  const normalizedRequests = chatPrimary.evidence.comparison?.normalized?.["events.requests"];
  const requestsMatch =
    normalizedRequests !== undefined &&
    canonicalJson(normalizedRequests.oracle) === canonicalJson(normalizedRequests.candidate);
  const chatMatch = chatHashStable && requestsMatch;
  if (!chatMatch)
    throw new Error(
      `real chat probe diverged: hashStable=${String(chatHashStable)} requestsMatch=${String(requestsMatch)} primarySha=${String(primarySha)} repeatSha=${String(repeatSha)}`,
    );

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
      evidence: chatPrimary.evidencePath,
      repeatEvidence: chatRepeat.evidencePath,
      projectionSha256: primarySha,
      repeatProjectionSha256: repeatSha,
      requestsNormalizedMatch: requestsMatch,
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
if (existsSync(lockPath)) throw new Error(`lock not released at ${lockPath}`);
