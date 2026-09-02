import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  startFakeUpstream,
  type FakeUpstreamOptions,
  type UpstreamRecord,
} from "./fake-upstream.js";
import type { McpFixture } from "./fixtures.js";

export const root = resolve(import.meta.dirname, "../../..");
export const evidenceRoot = resolve(root, ".parity-evidence/t19");
export const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
export const oracleVenv = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv";
export const oraclePython = join(oracleVenv, "bin", "python3");
export const oracleCli = join(oracleVenv, "bin", "lohra");
export const oracleBackend = join(oracleCheckout, "backend");
export const oracleLauncher = resolve(import.meta.dirname, "oracle-launcher.py");
export const candidateLauncher = resolve(import.meta.dirname, "candidate-launcher.mjs");
export const candidateCli = resolve(root, "dist/cli.js");

const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";
const ORACLE_VERSION = "lohra 0.0.11\n";
const FORBIDDEN_PORTS = [11434, 9119, 8000] as const;

mkdirSync(evidenceRoot, { recursive: true });

function checked(executable: string, args: readonly string[], cwd = root): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  if (result.status !== 0) {
    throw new Error(`T19_GUARD_FAILED:${executable}:${String(result.status)}:${result.stderr}`);
  }
  return result.stdout;
}

export interface GuardResult {
  readonly oracleCommit: string;
  readonly oracleVersion: string;
  readonly targetSha: string;
}

export function runGuards(): GuardResult {
  const oracleCommit = checked("git", ["rev-parse", "HEAD"], oracleCheckout).trim();
  if (oracleCommit !== ORACLE_SHA) throw new Error(`T19_ORACLE_PIN:${oracleCommit}`);
  if (checked("git", ["status", "--porcelain"], oracleCheckout) !== "") {
    throw new Error("T19_ORACLE_DIRTY");
  }
  const oracleVersion = checked(oracleCli, ["--version"]);
  if (oracleVersion !== ORACLE_VERSION) throw new Error(`T19_ORACLE_VERSION:${oracleVersion}`);
  const targetSha = checked("git", ["rev-parse", "HEAD"]).trim();
  if (process.env.T19_HARNESS_DEV !== "1" && checked("git", ["status", "--porcelain"]) !== "") {
    throw new Error("T19_CANDIDATE_DIRTY");
  }
  return { oracleCommit, oracleVersion: oracleVersion.trim(), targetSha };
}

function portClosed(port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolveClosed) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (closed: boolean): void => {
      socket.destroy();
      resolveClosed(closed);
    };
    socket.setTimeout(timeoutMs, () => {
      settle(true);
    });
    socket.once("connect", () => {
      settle(false);
    });
    socket.once("error", () => {
      settle(true);
    });
  });
}

/** Corrected 11434 protocol: each scenario prefers an explicit TCP
 * precondition. The harness itself binds only kernel-assigned ephemeral
 * loopback ports and refuses the three shared/fixed ports by construction. */
export async function assertTcpPortsClosed(): Promise<void> {
  for (const port of FORBIDDEN_PORTS) {
    if (!(await portClosed(port))) throw new Error(`PRECONDITION_TCP_PORT_IN_USE:${String(port)}`);
  }
}

export interface RuntimePaths {
  readonly runtimeRoot: string;
  readonly home: string;
  readonly lohraHome: string;
  readonly cwd: string;
  readonly tmp: string;
}

function materialize(side: Side, tag: string): RuntimePaths {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `lohra-t19-${side}-${tag}-`));
  const home = join(runtimeRoot, "home");
  const lohraHome = join(home, "dot-lohra");
  const cwd = join(runtimeRoot, "cwd");
  const tmp = join(runtimeRoot, "tmp");
  for (const path of [home, lohraHome, cwd, tmp]) mkdirSync(path, { recursive: true });
  return { runtimeRoot, home, lohraHome, cwd, tmp };
}

export type Side = "oracle" | "candidate";

export type McpConfig = string | Readonly<Record<string, unknown>> | readonly unknown[] | null;

export interface ChatOptions {
  readonly tag: string;
  readonly prompt?: string;
  readonly mcpConfig?: McpConfig;
  readonly fixture?: McpFixture;
  readonly fake?: FakeUpstreamOptions;
  readonly extraArgv?: readonly string[];
}

export interface ChatObservation {
  readonly side: Side;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Readonly<Record<string, unknown>> | null;
  readonly records: readonly UpstreamRecord[];
  readonly listenerClosed: boolean;
}

function writeConfig(paths: RuntimePaths, config: McpConfig | undefined): void {
  if (config === undefined || config === null) return;
  writeFileSync(
    join(paths.lohraHome, "mcp.json"),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
    "utf8",
  );
}

function parseEnvelope(stdout: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function normalizeStderr(stderr: string): string {
  return stderr
    .replace(/^session: [0-9a-f]{32} {2}\(resume with --session [0-9a-f]{32}\)\n?/gmu, "")
    .replaceAll(/\b[0-9a-f]{32}\b/gu, "<ID>");
}

function runProcess(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function runChat(side: Side, options: ChatOptions): Promise<ChatObservation> {
  const paths = materialize(side, options.tag);
  writeConfig(paths, options.mcpConfig);
  const upstream = await startFakeUpstream(options.fake ?? {});
  const upstreamPort = Number(new URL(upstream.baseUrl).port);
  const baseEnv: Record<string, string> = {
    PATH: side === "oracle" ? `${dirname(oraclePython)}:/usr/bin:/bin` : "/usr/bin:/bin",
    HOME: paths.home,
    LOHRA_HOME: paths.lohraHome,
    TMPDIR: paths.tmp,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    FAKE_API_KEY: "dummy-t19-loopback-key",
    FAKE_BASE_URL: upstream.baseUrl,
    LOHRA_PROVIDER: "fakeprov",
    LOHRA_NO_WIZARD: "1",
    ...(options.fixture === undefined ? {} : { T19_MCP_FIXTURE: JSON.stringify(options.fixture) }),
    ...(side === "oracle"
      ? {
          PYTHONPATH: oracleBackend,
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        }
      : {}),
  };
  const prompt = options.prompt ?? "SCEN:ok hello";
  const common = ["chat", prompt, "--json", ...(options.extraArgv ?? [])];
  const executable = side === "oracle" ? oraclePython : process.execPath;
  const args =
    side === "oracle"
      ? [oracleLauncher]
      : ["--import", candidateLauncher, candidateCli, ...common, "--provider", "fakeprov"];
  const env = side === "oracle" ? { ...baseEnv, LOHRA_ARGV: JSON.stringify(common) } : baseEnv;
  const result = await (async () => {
    try {
      return await runProcess(executable, args, env, paths.cwd);
    } finally {
      await upstream.close();
      rmSync(paths.runtimeRoot, { recursive: true, force: true });
    }
  })();
  if (!(await portClosed(upstreamPort)))
    throw new Error(`T19_ORPHAN_LISTENER:${String(upstreamPort)}`);
  return {
    side,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: normalizeStderr(result.stderr),
    envelope: parseEnvelope(result.stdout),
    records: [...upstream.records],
    listenerClosed: true,
  };
}

export interface ScenarioResult {
  readonly id: string;
  readonly tier: string;
  readonly pass: boolean;
  readonly assertions: readonly (number | string)[];
  readonly projection: unknown;
  readonly note?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function sha(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

export function writeSuiteEvidence(
  suite: string,
  guards: GuardResult,
  results: readonly ScenarioResult[],
): Readonly<Record<string, unknown>> {
  const projections = results.map((result) => ({
    id: result.id,
    pass: result.pass,
    sha: sha(result.projection),
  }));
  const digest = sha(projections);
  const evidence = {
    suite,
    guards,
    scenarios: results.length,
    failures: results.filter((result) => !result.pass).length,
    digest,
    digestFormula: "sha256(canonical JSON of ordered {id,pass,sha(projection)} records)",
    projections,
    results,
  };
  writeFileSync(
    join(evidenceRoot, `${suite}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return evidence;
}
