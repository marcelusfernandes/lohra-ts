// Shared low-level primitives for the T11 [socket-bilateral] parity harness:
// process guards, ephemeral ports, real server lifecycle (oracle Python /
// candidate Node), raw-socket HTTP I/O and evidence writing. No scenario
// logic lives here — scenario modules import these and describe what to
// probe; this file only knows how to stand a server up and talk to it on
// the wire.
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../../..");
export const oracleCheckout = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/lohra";
export const oracleVenv = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts/.oracle-venv";
export const oraclePython = join(oracleVenv, "bin", "python3");
export const oracleCliBin = join(oracleVenv, "bin", "lohra");
export const oracleLauncher = resolve(import.meta.dirname, "oracle-launcher.py");
export const candidateLauncher = resolve(import.meta.dirname, "candidate-launcher.mjs");
export const candidateCli = resolve(root, "dist/cli.js");
export const evidenceRoot = resolve(root, ".parity-evidence/t11");
mkdirSync(evidenceRoot, { recursive: true });

const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";
const ORACLE_VERSION = "lohra 0.0.11\n";
const FIXED_API_KEY = "T11-FIXED-TEST-KEY-do-not-rotate";
const FAKE_UPSTREAM_KEY = "FAKE-UPSTREAM-KEY-T11";

/** Assertion 8 — headers/body/logs/env/stderr-stdout/evidence get scrubbed.
 * These two are our own fixed test credentials (never a real secret — the
 * whole harness runs against a loopback fixture, decision 3), but they are
 * still Authorization-shaped values, so `writeEvidence` redacts them from
 * every record by default before it touches disk. */
const redactedByDefault = new Set<string>([FIXED_API_KEY, FAKE_UPSTREAM_KEY]);

/** A deliberately PLANTED canary — a value that must NEVER survive
 * redaction. Only `t11-scrub-planted-canaries` (probe 6) registers one, to
 * prove the scrub choke point in `writeEvidence` actually refuses a write
 * and exits non-zero when contamination slips past redaction. */
const scrubCanaries = new Set<string>();
export function registerScrubCanary(value: string): void {
  scrubCanaries.add(value);
}

export interface Guards {
  readonly oracleCommit: string;
  readonly targetSha: string;
}

function checkedOutput(executable: string, args: readonly string[], cwd = root): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0)
    throw new Error(`T11_GUARD_FAILED:${executable}:${String(result.status)}:${result.stderr}`);
  return result.stdout;
}

/** Assertion 1: pinned oracle commit, `lohra 0.0.11`, clean porcelain, absolute
 * `.oracle-venv` binaries — any mismatch fails before any listener comes up. */
export function runGuards(): Guards {
  const oracleCommit = checkedOutput("git", ["rev-parse", "HEAD"], oracleCheckout).trim();
  if (oracleCommit !== ORACLE_SHA) throw new Error(`T11_ORACLE_PIN:${oracleCommit}`);
  if (checkedOutput("git", ["status", "--porcelain"], oracleCheckout) !== "")
    throw new Error("T11_ORACLE_DIRTY");
  if (checkedOutput(oracleCliBin, ["--version"]) !== ORACLE_VERSION)
    throw new Error("T11_ORACLE_VERSION");
  const targetSha = checkedOutput("git", ["rev-parse", "HEAD"]).trim();
  if (process.env.T11_HARNESS_DEV !== "1" && checkedOutput("git", ["status", "--porcelain"]) !== "")
    throw new Error("T11_CANDIDATE_DIRTY");
  return { oracleCommit, targetSha };
}

export function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

function waitForListening(port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolveWait, reject) => {
    const attempt = (): void => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolveWait();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`T11_LISTEN_TIMEOUT:${String(port)}`));
          return;
        }
        setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

export interface ServerConfig {
  readonly insecure?: boolean;
  readonly tools?: string;
  readonly emptyModels?: boolean;
  /** null = --insecure semantics tested elsewhere; a string pins the API
   * key so both sides authenticate with an identical, non-random value. */
  readonly apiKey?: string | null;
  /** Pre-seeds `home/auth.json` before the process spawns — the only way
   * to exercise the subscription-gate's positive/negative controls with a
   * server that's actually expected to reach LISTEN (`startServer` waits
   * for it), as opposed to `[processo-ts]`'s own `seedSubscriptionAuth` +
   * `runProcessToCompletion` pairing for the REFUSAL cases. */
  readonly seedAuth?: {
    readonly authMode: string;
    readonly acknowledgedTosRisk: boolean;
    readonly preference?: string;
  };
}

export interface RuntimePaths {
  readonly runtimeRoot: string;
  readonly home: string;
  readonly cwd: string;
  readonly tmp: string;
}

export function materialize(side: "oracle" | "candidate"): RuntimePaths {
  const runtimeRoot = mkdtempSync(join(tmpdir(), `lohra-t11-${side}-`));
  const home = join(runtimeRoot, "home");
  const cwd = join(runtimeRoot, "project");
  const tmp = join(runtimeRoot, "tmp");
  for (const path of [home, cwd, tmp]) mkdirSync(path, { recursive: true });
  return { runtimeRoot, home, cwd, tmp };
}

export interface ServerHandle {
  readonly side: "oracle" | "candidate";
  readonly port: number;
  readonly paths: RuntimePaths;
  readonly apiKey: string | null;
  readonly stdout: () => string;
  readonly stderr: () => string;
  stop(
    signal?: NodeJS.Signals,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface ServeInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly apiKey: string | null;
}

/** Builds the exact env/argv `startServer` and the `[processo-ts]` helpers
 * both launch — a subscription-gate or occupied-port scenario needs the
 * IDENTICAL invocation a bilateral scenario uses, just observed for
 * refusal instead of success. `loopbackUpstreamUrl`/`FAKE_BASE_URL` are
 * still required even when the gate is expected to fire before any
 * provider call: `oracle-launcher.py` reads `os.environ["FAKE_BASE_URL"]`
 * unconditionally while registering the fixture profile. */
export function buildServeInvocation(
  side: "oracle" | "candidate",
  config: ServerConfig,
  loopbackUpstreamUrl: string,
  paths: RuntimePaths,
  port: number,
): ServeInvocation {
  const apiKey = config.insecure ? null : (config.apiKey ?? FIXED_API_KEY);
  const env: Record<string, string> = {
    PATH: side === "oracle" ? `${resolve(oraclePython, "..")}:/usr/bin:/bin` : "/usr/bin:/bin",
    HOME: paths.home,
    LOHRA_HOME: paths.home,
    TMPDIR: paths.tmp,
    TZ: "UTC",
    COLUMNS: "80",
    NO_COLOR: "1",
    FAKE_API_KEY: "FAKE-UPSTREAM-KEY-T11",
    FAKE_BASE_URL: loopbackUpstreamUrl,
    LOHRA_PORT: String(port),
    ...(config.emptyModels ? { LOHRA_T11_EMPTY_MODELS: "1" } : {}),
    ...(config.insecure ? { LOHRA_INSECURE: "1" } : {}),
    ...(config.tools ? { LOHRA_TOOLS: config.tools } : {}),
    ...(apiKey !== null ? { LOHRA_OPENAI_API_KEY: apiKey } : {}),
    ...(side === "oracle"
      ? {
          PYTHONPATH: join(oracleCheckout, "backend"),
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        }
      : {}),
  };
  const [executable, args] =
    side === "oracle"
      ? [oraclePython, [oracleLauncher]]
      : [
          process.execPath,
          [
            "--import",
            candidateLauncher,
            candidateCli,
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            ...(config.insecure ? ["--insecure"] : []),
            ...(config.tools ? ["--tools", config.tools] : []),
          ],
        ];
  return { executable, args, env, apiKey };
}

export async function startServer(
  side: "oracle" | "candidate",
  config: ServerConfig,
  loopbackUpstreamUrl: string,
): Promise<ServerHandle> {
  const port = await allocatePort();
  const paths = materialize(side);
  if (config.seedAuth !== undefined) seedSubscriptionAuth(paths, config.seedAuth);
  const { executable, args, env, apiKey } = buildServeInvocation(
    side,
    config,
    loopbackUpstreamUrl,
    paths,
    port,
  );
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(executable, args, {
    cwd: paths.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  let settled: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("close", (exitCode, signal) => {
    settled = { exitCode, signal };
  });

  try {
    await waitForListening(port);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(paths.runtimeRoot, { recursive: true, force: true });
    throw new Error(
      `T11_SERVER_DID_NOT_START:${side}:${String(error)}:stderr=${Buffer.concat(stderrChunks).toString("utf8")}`,
      { cause: error },
    );
  }

  return {
    side,
    port,
    paths,
    apiKey,
    stdout: () => Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    stop: (signal: NodeJS.Signals = "SIGINT") =>
      new Promise((resolveStop) => {
        if (settled !== null) {
          resolveStop(settled);
          return;
        }
        child.once("close", (exitCode, closeSignal) => {
          resolveStop({ exitCode, signal: closeSignal });
        });
        child.kill(signal);
        setTimeout(() => {
          if (settled === null) child.kill("SIGKILL");
        }, 4000);
      }),
  };
}

export async function stopAndCleanup(
  handle: ServerHandle,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const result = await handle.stop("SIGINT");
  rmSync(handle.paths.runtimeRoot, { recursive: true, force: true });
  return result;
}

export interface RawResponse {
  readonly statusLine: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

function dechunk(buffer: Buffer): string {
  let offset = 0;
  let out = "";
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeHex = buffer.subarray(offset, lineEnd).toString("ascii").trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    out += buffer.subarray(dataStart, dataStart + size).toString("utf8");
    offset = dataStart + size + 2;
  }
  return out;
}

/** Raw HTTP/1.1 over a cru TCP socket — never `fetch()`, which normalizes
 * away exactly the headers/framing under test. Every request line the
 * caller supplies must include `Connection: close` so the socket end event
 * fires deterministically once the response is complete. */
export function sendRaw(port: number, requestLines: string, body = ""): Promise<RawResponse> {
  return new Promise((resolveSend, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestLines.replaceAll("\n", "\r\n") + "\r\n" + body);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      const headerText = raw.subarray(0, headerEnd).toString("utf8");
      const bodyRaw = raw.subarray(headerEnd + 4);
      const [statusLine, ...headerLines] = headerText.split("\r\n");
      const headers: [string, string][] = [];
      let isChunked = false;
      for (const line of headerLines) {
        const index = line.indexOf(":");
        const name = line.slice(0, index).toLowerCase();
        const value = line.slice(index + 1).trim();
        headers.push([name, value]);
        if (name === "transfer-encoding" && value.toLowerCase() === "chunked") isChunked = true;
      }
      const responseBody = isChunked ? dechunk(bodyRaw) : bodyRaw.toString("utf8");
      resolveSend({ statusLine: statusLine ?? "", headers, body: responseBody });
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("T11_RAW_REQUEST_TIMEOUT"));
    }, 8000);
  });
}

export interface ProbeRecord {
  readonly id: string;
  readonly request: string;
  readonly oracle: RawResponse;
  readonly candidate: RawResponse;
}

/** Oracle then candidate, never `Promise.all` — a scenario that talks to the
 * shared fake upstream needs its two sides' upstream requests to land in a
 * known order so a caller can slice `upstream.requests` cleanly between
 * them and attribute per-side counts (assertions 21/29/64). A concurrent
 * probe would interleave both sides' upstream traffic nondeterministically. */
export async function probeBoth(
  id: string,
  oracle: ServerHandle,
  candidate: ServerHandle,
  requestLines: (apiKey: string | null, side: "oracle" | "candidate") => string,
  body = "",
): Promise<ProbeRecord> {
  const oracleRequest = requestLines(oracle.apiKey, "oracle");
  const oracleResponse = await sendRaw(oracle.port, oracleRequest, body);
  const candidateRequest = requestLines(candidate.apiKey, "candidate");
  const candidateResponse = await sendRaw(candidate.port, candidateRequest, body);
  return { id, request: oracleRequest, oracle: oracleResponse, candidate: candidateResponse };
}

export function headerValue(response: RawResponse, name: string): string | undefined {
  return response.headers.find(([key]) => key === name.toLowerCase())?.[1];
}

export interface NormalizedView {
  readonly statusLine: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Header field ORDER is not governed by the contract (assertion 9 only pins
 * body key order) — sorted so comparisons aren't a false positive on
 * ordering alone. `date`/`server` are declared-normalized away entirely
 * (uvicorn sends `server`, Node sends neither header). */
export function normalizeForComparison(
  response: RawResponse,
  bodyOverride?: string,
  extraDroppedHeaders: readonly string[] = [],
): NormalizedView {
  const dropped = new Set(["date", "server", ...extraDroppedHeaders]);
  return {
    statusLine: response.statusLine,
    headers: Object.fromEntries(
      response.headers
        .filter(([name]) => !dropped.has(name))
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    body: bodyOverride ?? response.body,
  };
}

/** The default byte-exact comparison: status line, headers (order-insensitive,
 * volatile ones dropped) and body must match exactly. Most 422/400/401/404/405
 * probes need nothing more — scenarios with dynamic body fields (ids,
 * `created`) normalize the body first and pass the result as `bodyOverride`. */
export function compareRaw(
  oracle: RawResponse,
  candidate: RawResponse,
  options: {
    readonly oracleBody?: string;
    readonly candidateBody?: string;
    /** Extra headers to drop before comparing — e.g. `content-length` when
     * an excused body field (a differing byte count) makes the true wire
     * length meaningless to compare, even though the normalized body text
     * itself is being compared. */
    readonly extraDroppedHeaders?: readonly string[];
  } = {},
): {
  readonly match: boolean;
  readonly oracle: NormalizedView;
  readonly candidate: NormalizedView;
} {
  const oracleView = normalizeForComparison(
    oracle,
    options.oracleBody,
    options.extraDroppedHeaders,
  );
  const candidateView = normalizeForComparison(
    candidate,
    options.candidateBody,
    options.extraDroppedHeaders,
  );
  return {
    match: JSON.stringify(oracleView) === JSON.stringify(candidateView),
    oracle: oracleView,
    candidate: candidateView,
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeEvidence(id: string, record: unknown): string {
  let text = JSON.stringify(record, null, 2);
  for (const secret of redactedByDefault) text = text.replaceAll(secret, "<REDACTED>");
  for (const canary of scrubCanaries) {
    if (text.includes(canary)) throw new Error(`T11_SCRUB_HIT:${id}:${canary}`);
  }
  writeFileSync(join(evidenceRoot, `${id}.json`), `${text}\n`, "utf8");
  return sha256(text);
}

/** Seeds `home/auth.json` in the exact shape both sides' own config
 * readers expect (`src/auth/store.ts`'s `readConfig`, and the oracle's
 * equivalent) — `{"openai": {auth_mode, acknowledged_tos_risk, preference}}`.
 * Used by the `[processo-ts]` subscription-gate scenarios. */
export function seedSubscriptionAuth(
  paths: RuntimePaths,
  config: {
    readonly authMode: string;
    readonly acknowledgedTosRisk: boolean;
    readonly preference?: string;
  },
): void {
  writeFileSync(
    join(paths.home, "auth.json"),
    JSON.stringify({
      openai: {
        auth_mode: config.authMode,
        acknowledged_tos_risk: config.acknowledgedTosRisk,
        preference: config.preference ?? "auto",
      },
    }),
    "utf8",
  );
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a `serve` invocation to completion (or kills it after `timeoutMs` —
 * itself a failure for every `[processo-ts]` scenario that expects a fast,
 * deterministic refusal) instead of waiting for it to start listening.
 * Never touches the caller's `loopbackUpstreamUrl`/port beyond what
 * `buildServeInvocation` already needs. */
export function runProcessToCompletion(
  invocation: ServeInvocation,
  cwd: string,
  timeoutMs = 8000,
): Promise<ProcessResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(
        new Error(`T11_PROCESS_TIMEOUT:stderr=${Buffer.concat(stderrChunks).toString("utf8")}`),
      );
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

export { FIXED_API_KEY, FAKE_UPSTREAM_KEY };
