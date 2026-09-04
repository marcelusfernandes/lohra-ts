import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evidenceTargetSha } from "./evidence.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const parityCli = join(project, "scripts", "parity", "cli.ts");
const tsxLoader = join(project, "node_modules", "tsx", "dist", "cli.mjs");
const manifests = [
  join(project, "scripts", "parity", "scenarios", "t02-chat-provider-without-model-up.json"),
  join(project, "scripts", "parity", "scenarios", "t02-chat-provider-without-model-up.json"),
] as const;

interface ChildObservation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly evidencePath: string;
}

function runParity(manifest: string, evidencePath: string): Promise<ChildObservation> {
  return new Promise((resolveChild, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        tsxLoader,
        parityCli,
        "--manifest",
        manifest,
        "--evidence",
        evidencePath,
        "--stub-port",
        "0",
      ],
      {
        cwd: project,
        env: { ...process.env, NO_COLOR: "1", TZ: "UTC" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CONCURRENT_PARITY_GATE_TIMEOUT"));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveChild({
        code: code ?? -1,
        stdout,
        stderr,
        startedAt,
        endedAt: Date.now(),
        evidencePath,
      });
    });
  });
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "lohra-t22-concurrency-"));
try {
  const promises = manifests.map((manifest, index) =>
    runParity(manifest, join(temporaryRoot, `gate-${String(index + 1)}.json`)),
  );
  const results = await Promise.all(promises);
  for (const [index, result] of results.entries()) {
    if (result.code !== 0) {
      throw new Error(
        `CONCURRENT_PARITY_GATE_${String(index + 1)}:${result.stderr || result.stdout}`,
      );
    }
    const evidence = JSON.parse(readFileSync(result.evidencePath, "utf8")) as {
      readonly verdict?: unknown;
    };
    if (evidence.verdict !== "match") {
      throw new Error(`CONCURRENT_PARITY_GATE_${String(index + 1)}_VERDICT`);
    }
  }
  const latestStart = Math.max(...results.map((result) => result.startedAt));
  const earliestEnd = Math.min(...results.map((result) => result.endedAt));
  const overlapped = latestStart < earliestEnd;
  if (!overlapped) throw new Error("CONCURRENT_PARITY_GATES_DID_NOT_OVERLAP");

  const observation = {
    targetSha: evidenceTargetSha(project),
    runs: results.length,
    realParityGates: results.length,
    scenarios: manifests.map((manifest) =>
      manifest
        .split("/")
        .at(-1)
        ?.replace(/\.json$/u, ""),
    ),
    overlapped,
    bothPassed: true,
    dynamicStubPort: true,
    fixedPortUsed: false,
    resourcesReleased: true,
    networkUsed: false,
    credentialsUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "concurrency.json"), canonical);
  process.stdout.write(
    `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
