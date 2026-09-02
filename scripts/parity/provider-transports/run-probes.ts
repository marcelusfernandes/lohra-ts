#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../canonical.js";

const root = resolve(import.meta.dirname, "../../..");
const oraclePython =
  "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv/bin/python";
const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
const oracleDriver = resolve(import.meta.dirname, "oracle_probes.py");
const candidateDriver = resolve(import.meta.dirname, "candidate-probes.mjs");
const evidenceRoot = resolve(root, ".probe-evidence/t10");
mkdirSync(evidenceRoot, { recursive: true });
const targetSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const runtime = mkdtempSync(join(tmpdir(), "lohra-t10-probes-"));

function run(executable: string, args: readonly string[], env: Record<string, string>) {
  const result = spawnSync(executable, args, {
    cwd: runtime,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`PROBE_DRIVER_FAILED:${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

try {
  const profile = join(runtime, "profile");
  const home = join(runtime, "home");
  const codex = join(runtime, "codex");
  const temp = join(runtime, "tmp");
  for (const directory of [profile, home, codex, temp]) mkdirSync(directory, { recursive: true });
  const common = {
    PATH: "/usr/bin:/bin",
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    TZ: "UTC",
    COLUMNS: "80",
    NO_COLOR: "1",
    HOME: home,
    LOHRA_HOME: profile,
    CODEX_HOME: codex,
    TMPDIR: temp,
  };
  const oracleRun = run(oraclePython, [oracleDriver], {
    ...common,
    PYTHONPATH: join(oracleCheckout, "backend"),
  });
  const candidateRun = run(process.execPath, [candidateDriver], common);
  const oracle = JSON.parse(oracleRun.stdout) as Record<string, unknown>;
  const candidate = JSON.parse(candidateRun.stdout) as Record<string, unknown>;
  const names = Object.keys(oracle).sort();
  if (names.length !== 26 || canonicalJson(names) !== canonicalJson(Object.keys(candidate).sort()))
    throw new Error(`PROBE_INVENTORY_INVALID:${String(names.length)}`);
  let failures = 0;
  const projections: Array<{ id: string; sha: string; match: boolean; classification: string }> =
    [];
  for (const id of names) {
    const oracleValue = oracle[id];
    const candidateValue = candidate[id];
    let match = canonicalJson(oracleValue) === canonicalJson(candidateValue);
    let classification = "bilateral-match";
    if (id === "t10-tool-schema-mutation-three-way") {
      const left = oracleValue as Record<string, unknown>;
      const right = candidateValue as Record<string, unknown>;
      match =
        left.classification === right.classification &&
        left.chat_changed === false &&
        right.chat_changed === false &&
        left.anthropic_changed === true &&
        right.anthropic_changed === false &&
        left.responses_changed === false &&
        right.responses_changed === false;
      classification = "expected-divergence-anthropic-alias-only";
    }
    if (!match) failures += 1;
    const projection = {
      id,
      layer: "probe-bilateral",
      classification,
      oracle: oracleValue,
      candidate: candidateValue,
    };
    const sha = createHash("sha256").update(canonicalJson(projection)).digest("hex");
    projections.push({ id, sha, match, classification });
    writeFileSync(
      join(evidenceRoot, `${id}.json`),
      `${JSON.stringify({ schemaVersion: 1, targetSha, ...projection, differences: match ? [] : [{ oracle: oracleValue, candidate: candidateValue }], projectionSha256: sha }, null, 2)}\n`,
    );
  }
  const digest = createHash("sha256")
    .update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join(""))
    .digest("hex");
  process.stdout.write(
    `${JSON.stringify({ suite: "t10-provider-transports-probes", probes: names.length, failures, digest, projections })}\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(runtime, { recursive: true, force: true });
}
