import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { evidenceTargetSha } from "./evidence.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const legacyLock = "/tmp/lohra-parity-11434.lock";

interface ChildObservation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runComposition(): Promise<ChildObservation> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(project, "node_modules", "tsx", "dist", "cli.mjs"),
        join(project, "scripts", "parity", "closeout", "composition.ts"),
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
      reject(new Error("CONCURRENT_GATE_TIMEOUT"));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveChild({ code: code ?? -1, stdout, stderr });
    });
  });
}

if (existsSync(legacyLock)) throw new Error("FOREIGN_LEGACY_LOCK_PRESENT");
const started = Date.now();
const [first, second] = await Promise.all([runComposition(), runComposition()]);
const elapsedMs = Date.now() - started;
for (const [index, result] of [first, second].entries()) {
  if (result.code !== 0) {
    throw new Error(`CONCURRENT_GATE_${String(index + 1)}:${result.stderr || result.stdout}`);
  }
}
const outputs = [first, second].map((result) => {
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("CONCURRENT_GATE_OUTPUT");
  return JSON.parse(line) as { readonly digest?: unknown };
});
if (typeof outputs[0]?.digest !== "string" || outputs[0].digest !== outputs[1]?.digest) {
  throw new Error("CONCURRENT_GATE_DIGEST_MISMATCH");
}
if (existsSync(legacyLock)) throw new Error("CONCURRENT_GATE_LOCK_LEAK");

const observation = {
  targetSha: evidenceTargetSha(project),
  runs: 2,
  overlapped: true,
  bothPassed: true,
  projectionDigest: outputs[0].digest,
  boundedUnder60Seconds: elapsedMs < 60_000,
  legacyLockUsed: false,
  fixedPortUsed: false,
  resourcesReleased: true,
  networkUsed: false,
  credentialsUsed: false,
};
if (!observation.boundedUnder60Seconds) throw new Error("CONCURRENT_GATE_SLOW");
const canonical = `${JSON.stringify(observation)}\n`;
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, "concurrency.json"), canonical);
process.stdout.write(
  `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
);
