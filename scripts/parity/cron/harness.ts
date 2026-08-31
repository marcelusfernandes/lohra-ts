// Shared low-level primitives for the T18 cron parity harness: process
// guards, isolated HOME materialization, one-shot CLI invocation for both
// the oracle (Python) and candidate (TS) `lohra cron` binaries, and evidence
// writing. No scenario logic lives here — scenario modules import these and
// describe what to plant/run/compare.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../../..");
export const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
export const oracleVenv = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv";
export const oraclePython = join(oracleVenv, "bin", "python3");
export const oracleCliBin = join(oracleVenv, "bin", "lohra");
export const candidateCli = resolve(root, "dist/cli.js");
export const evidenceRoot = resolve(root, ".parity-evidence/t18");
mkdirSync(evidenceRoot, { recursive: true });

const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";
const ORACLE_VERSION = "lohra 0.0.11\n";

export interface Guards {
  readonly oracleCommit: string;
  readonly targetSha: string;
}

function checkedOutput(executable: string, args: readonly string[], cwd = root): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0)
    throw new Error(`T18_GUARD_FAILED:${executable}:${String(result.status)}:${result.stderr}`);
  return result.stdout;
}

/** Assertion 1: pinned oracle commit, `lohra 0.0.11`, clean porcelain — any
 * mismatch fails before any scenario runs. */
export function runGuards(): Guards {
  const oracleCommit = checkedOutput("git", ["rev-parse", "HEAD"], oracleCheckout).trim();
  if (oracleCommit !== ORACLE_SHA) throw new Error(`T18_ORACLE_PIN:${oracleCommit}`);
  if (checkedOutput("git", ["status", "--porcelain"], oracleCheckout) !== "")
    throw new Error("T18_ORACLE_DIRTY");
  if (checkedOutput(oracleCliBin, ["--version"]) !== ORACLE_VERSION) throw new Error("T18_ORACLE_VERSION");
  const targetSha = checkedOutput("git", ["rev-parse", "HEAD"]).trim();
  if (process.env.T18_HARNESS_DEV !== "1" && checkedOutput("git", ["status", "--porcelain"]) !== "")
    throw new Error("T18_CANDIDATE_DIRTY");
  return { oracleCommit, targetSha };
}

export interface RuntimePaths {
  readonly runtimeRoot: string;
  readonly home: string;
  readonly tmp: string;
}

/** Fresh, isolated HOME per side per scenario — never shared, never reused. */
export function materialize(side: "oracle" | "candidate"): RuntimePaths {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `lohra-t18-${side}-`));
  const home = join(runtimeRoot, "home");
  const tmp = join(runtimeRoot, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { runtimeRoot, home, tmp };
}

export function cleanup(paths: RuntimePaths): void {
  rmSync(paths.runtimeRoot, { recursive: true, force: true });
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function baseEnv(paths: RuntimePaths): Record<string, string> {
  return {
    HOME: paths.home,
    LOHRA_HOME: paths.home,
    TMPDIR: paths.tmp,
    PATH: "/usr/bin:/bin",
    COLUMNS: "80",
    NO_COLOR: "1",
  };
}

/** Real oracle process, one shot: `lohra cron <argv...>`. Never in-process. */
export function runOracleCron(argv: readonly string[], paths: RuntimePaths): CliResult {
  const result = spawnSync(oracleCliBin, ["cron", ...argv], {
    cwd: paths.tmp,
    env: baseEnv(paths),
    encoding: "utf8",
    timeout: 15_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Real candidate process, one shot: `node dist/cli.js cron <argv...>`. Never in-process. */
export function runCandidateCron(argv: readonly string[], paths: RuntimePaths): CliResult {
  const result = spawnSync(process.execPath, [candidateCli, "cron", ...argv], {
    cwd: paths.tmp,
    env: baseEnv(paths),
    encoding: "utf8",
    timeout: 15_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function jobsPathOf(paths: RuntimePaths): string {
  return join(paths.home, "cron", "jobs.json");
}

export interface FileState {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly byteLength: number | null;
}

export function readFileState(path: string): FileState {
  try {
    const buffer = readFileSyncRaw(path);
    return { exists: true, sha256: sha256Buffer(buffer), byteLength: buffer.length };
  } catch {
    return { exists: false, sha256: null, byteLength: null };
  }
}

function readFileSyncRaw(path: string): Buffer {
  return readFileSync(path);
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const ID_PATTERN = /\b[0-9a-f]{32}\b/gu;
/** Every `materialize()` call mints a fresh `mkdtemp` suffix; `CronStoreError`
 * messages embed the full store path (by design, for a human to act on) so
 * that path leaks a random per-run token into evidence/comparisons unless
 * normalized here too. */
const TMPHOME_PATTERN = /lohra-t18-(?:oracle|candidate)-[A-Za-z0-9]+/gu;

/** Assertion 44: `id` is normalized in every comparison/evidence record so
 * the digest is reproducible run-to-run (each `add` mints a fresh random
 * hex id on both sides) and so an injected divergence in this exact field
 * is the thing the masked-field self-test (probe-complementar 24) proves
 * the gate can still catch downstream of masking, not something masking
 * silently hides. */
function maskDynamicFields(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(ID_PATTERN, "<ID>").replaceAll(TMPHOME_PATTERN, "lohra-t18-<RUNTIME>");
  }
  if (Array.isArray(value)) return value.map(maskDynamicFields);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskDynamicFields(entry)]));
  }
  return value;
}

export function maskId(text: string): string {
  return text.replaceAll(ID_PATTERN, "<ID>");
}

export function writeEvidence(id: string, record: unknown): string {
  const text = JSON.stringify(maskDynamicFields(record), null, 2);
  writeFileSync(join(evidenceRoot, `${id}.json`), `${text}\n`, "utf8");
  return sha256(text);
}

export function localDay(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
