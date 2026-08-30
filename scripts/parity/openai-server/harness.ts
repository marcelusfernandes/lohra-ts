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
  if (checkedOutput(oracleCliBin, ["--version"]) !== ORACLE_VERSION) throw new Error("T11_ORACLE_VERSION");
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
      probe.close(() => { resolvePort(port); });
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
}

export interface RuntimePaths {
  readonly runtimeRoot: string;
  readonly home: string;
  readonly cwd: string;
  readonly tmp: string;
}

function materialize(side: "oracle" | "candidate"): RuntimePaths {
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
  stop(signal?: NodeJS.Signals): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export async function startServer(
  side: "oracle" | "candidate",
  config: ServerConfig,
  loopbackUpstreamUrl: string,
): Promise<ServerHandle> {
  const port = await allocatePort();
  const paths = materialize(side);
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
    ...(side === "oracle" ? { PYTHONPATH: join(oracleCheckout, "backend"), PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } : {}),
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

export async function stopAndCleanup(handle: ServerHandle): Promise<void> {
  await handle.stop("SIGINT");
  rmSync(handle.paths.runtimeRoot, { recursive: true, force: true });
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

export function headerValue(response: RawResponse, name: string): string | undefined {
  return response.headers.find(([key]) => key === name.toLowerCase())?.[1];
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeEvidence(id: string, record: unknown): string {
  const sha = sha256(JSON.stringify(record));
  writeFileSync(join(evidenceRoot, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return sha;
}

export { FIXED_API_KEY };
