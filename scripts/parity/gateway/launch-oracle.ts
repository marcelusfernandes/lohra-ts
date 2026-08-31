// Spawns the REAL Python oracle `lohra dashboard` as a genuinely separate
// process, hermetically isolated (fresh HOME/LOHRA_HOME/TMPDIR, env built
// from scratch, zero real credentials, upstream pinned to a loopback fake).
// Mirrors launch-candidate.ts's shape so scenario scripts can treat both
// sides symmetrically.
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ORACLE_ROOT = "/Users/marcelusfernandes/Desktop/playground-ai/lohra-ts";
const ORACLE_CHECKOUT = join(ORACLE_ROOT, "lohra");
const ORACLE_PYTHON = join(ORACLE_ROOT, ".oracle-venv/bin/python");
const ORACLE_COMMIT = "16b4785d803ad0ca364a8a67346a04f949fbf592";
const ORACLE_VERSION_LINE = "lohra 0.0.11";
const LAUNCHER_SCRIPT = resolve(import.meta.dirname, "oracle-dash-launcher.py");

export interface OracleGuardResult {
  readonly ok: boolean;
  readonly detail: string;
}

// Fails BEFORE anything is spawned if the oracle checkout has drifted from
// its pinned commit, isn't porcelain-clean, or the venv doesn't resolve to
// the expected package version -- matching the guard discipline the T12
// baseline itself was measured under.
export function verifyOracleGuard(): OracleGuardResult {
  const commit = spawnSync("git", ["-C", ORACLE_CHECKOUT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (commit.status !== 0) return { ok: false, detail: `ORACLE_COMMIT_CHECK_FAILED:${commit.stderr}` };
  if (commit.stdout.trim() !== ORACLE_COMMIT) {
    return {
      ok: false,
      detail: `ORACLE_COMMIT_MISMATCH expected=${ORACLE_COMMIT} got=${commit.stdout.trim()}`,
    };
  }

  const porcelain = spawnSync("git", ["-C", ORACLE_CHECKOUT, "status", "--porcelain"], {
    encoding: "utf8",
  });
  if (porcelain.status !== 0 || porcelain.stdout.length > 0) {
    return { ok: false, detail: `ORACLE_CHECKOUT_NOT_CLEAN:${porcelain.stdout}` };
  }

  const version = spawnSync(ORACLE_PYTHON, ["-m", "lohra.cli", "--version"], { encoding: "utf8" });
  if (version.status !== 0 || !version.stdout.includes(ORACLE_VERSION_LINE)) {
    return {
      ok: false,
      detail: `ORACLE_VERSION_MISMATCH expected~=${ORACLE_VERSION_LINE} got=${version.stdout}${version.stderr}`,
    };
  }

  return { ok: true, detail: "ok" };
}

export interface LaunchedOracleProcess {
  readonly port: number;
  readonly pid: number;
  stderrText(): string;
  stdoutText(): string;
  kill(signal?: NodeJS.Signals): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface LaunchOracleInput {
  readonly fakeUpstreamPort: number;
  readonly insecure?: boolean;
  readonly noOpen?: boolean;
  readonly bootTimeoutMs?: number;
}

// The oracle's `run_dashboard` prints the literal --port argument it was
// given, not an OS-resolved bound port (backend/lohra/cli.py's
// `run_dashboard` does `print(f"...{port}")` using the argument straight
// through) -- unlike this session's own TS candidate, it has no support
// for "--port 0" meaning "pick one for me". So this harness picks a real
// ephemeral port itself (bind-then-close on loopback, same TOCTOU
// tradeoff any such probe makes) and passes that concrete number through,
// rather than trusting a parsed-back port number.
async function pickEphemeralPort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolvePromise(port);
      });
    });
  });
}

// backend/lohra/cli.py's `run_dashboard` prints the boot line BEFORE
// calling `uvicorn.run(...)`, so seeing the line on stderr does not mean
// the listening socket exists yet -- a probe dialed immediately after
// gets ECONNREFUSED. This polls a real TCP connect until it succeeds (or
// times out), which is the only way to observe true readiness here.
async function waitForPortReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolvePromise) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolvePromise(false);
      });
    });
    if (reachable) return;
    if (Date.now() >= deadline) {
      throw new Error(`ORACLE_PORT_NOT_READY after ${String(timeoutMs)}ms on port ${String(port)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

export async function launchOracleDashboard(
  input: LaunchOracleInput,
): Promise<LaunchedOracleProcess> {
  const guard = verifyOracleGuard();
  if (!guard.ok) throw new Error(`ORACLE_GUARD_FAILED:${guard.detail}`);

  const port = await pickEphemeralPort();
  const bootLine = `Lohra dashboard: http://127.0.0.1:${String(port)}`;
  const home = mkdtempSync(join(tmpdir(), "lohra-oracle-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "lohra-oracle-codex-"));

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: home,
    LOHRA_HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: mkdtempSync(join(tmpdir(), "lohra-oracle-tmp-")),
    FAKE_API_KEY: "dummy-fake-key",
    FAKE_BASE_URL: `http://127.0.0.1:${String(input.fakeUpstreamPort)}/v1`,
    LOHRA_PROVIDER: "fakeprov",
    LOHRA_PORT: String(port),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (input.insecure === true) env.LOHRA_INSECURE = "1";
  if (input.noOpen === true) env.LOHRA_NO_OPEN = "1";

  const child = spawn(ORACLE_PYTHON, [LAUNCHER_SCRIPT], {
    cwd: home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  const stderrText = (): string => Buffer.concat(stderrChunks).toString("utf8");
  const stdoutText = (): string => Buffer.concat(stdoutChunks).toString("utf8");

  const bootTimeoutMs = input.bootTimeoutMs ?? 15_000;
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `ORACLE_BOOT_TIMEOUT after ${String(bootTimeoutMs)}ms; stderr so far: ${stderrText()}`,
        ),
      );
    }, bootTimeoutMs);

    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `ORACLE_EXITED_BEFORE_BOOT code=${String(exitCode)} signal=${String(signal)} stderr=${stderrText()}`,
        ),
      );
    });

    // Self-unregisters on match: left attached via .on(), this would keep
    // firing on every LATER stderr write for the rest of the process's
    // life (stderrText() is a cumulative buffer, so the match never stops
    // being true) -- each stray refire calling removeAllListeners("exit")
    // again, silently wiping out whatever exit listener kill() registers
    // afterward. That left kill() waiting on an 'exit' event that would
    // never fire even after the child had actually died.
    const checkForBootLine = (): void => {
      if (stderrText().includes(bootLine)) {
        clearTimeout(timeout);
        child.removeAllListeners("exit");
        child.stderr.removeListener("data", checkForBootLine);
        resolvePromise();
      }
    };
    child.stderr.on("data", checkForBootLine);
  });

  await waitForPortReady(port, bootTimeoutMs);

  return {
    port,
    pid: child.pid ?? -1,
    stderrText,
    stdoutText,
    // A graceful SIGINT shutdown can hang indefinitely if a request is
    // still "in flight" server-side when the signal arrives -- the ghost
    // turn (ADR-T12-02) is exactly that: a request the server never
    // completes on purpose, and this harness's own client-side
    // socket.destroy() never sends it a proper WS close handshake either.
    // Escalating to SIGKILL after a bounded wait means cleanup always
    // terminates, regardless of what state a scenario left the server in.
    kill: (signal = "SIGINT") =>
      new Promise((resolvePromise) => {
        let settled = false;
        const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(escalation);
          resolvePromise({ exitCode, signal: exitSignal });
        };
        const escalation = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", (exitCode, exitSignal) => {
          finish(exitCode, exitSignal);
        });
        child.kill(signal);
      }),
  };
}
