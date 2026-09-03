// Spawns the REAL TypeScript `dashboard` command wired to a loopback fake
// upstream via candidate-dash-launcher.ts (which calls the product's own
// registerProvider() -- zero product code touched). This is the candidate
// counterpart to launch-oracle.ts's hermetic env, needed for any scenario
// that drives an actual model turn (prompt.submit): launch-candidate.ts
// alone dials a real provider and would diverge/fail there, so it stays
// untouched for the auth/routing-only scenarios that don't need this.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../../..");
const LAUNCHER_SCRIPT = resolve(projectRoot, "scripts/parity/gateway/candidate-dash-launcher.ts");
const TSX_CLI = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");

export interface LaunchedGatewayProcess {
  readonly port: number;
  readonly pid: number;
  stderrText(): string;
  stdoutText(): string;
  kill(
    signal?: NodeJS.Signals,
  ): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface LaunchCandidateFakeInput {
  readonly fakeUpstreamPort: number;
  readonly home: string;
  readonly insecure?: boolean;
  readonly bootTimeoutMs?: number;
  /** Pins LOHRA_DASHBOARD_SESSION_TOKEN so a scenario can thread a KNOWN
   * valid token through authenticated REST/WS calls instead of only
   * exercising the no-token/wrong-token negative paths -- dashboard.ts
   * honors this env var over its own secrets.token_urlsafe(32) fallback. */
  readonly dashboardToken?: string;
}

const BOOT_LINE_PATTERN = /^Lohra dashboard: http:\/\/127\.0\.0\.1:(\d+)\n$/mu;

export async function launchCandidateFakeUpstreamDashboard(
  input: LaunchCandidateFakeInput,
): Promise<LaunchedGatewayProcess> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: input.home,
    LOHRA_HOME: input.home,
    FAKE_API_KEY: "dummy-fake-key",
    FAKE_BASE_URL: `http://127.0.0.1:${String(input.fakeUpstreamPort)}/v1`,
    LOHRA_PORT: "0",
  };
  if (input.insecure === true) env.LOHRA_INSECURE = "1";
  if (input.dashboardToken !== undefined) env.LOHRA_DASHBOARD_SESSION_TOKEN = input.dashboardToken;

  // Resolve the checked-in dependency from the project instead of asking
  // `npx` to discover it from the fixture HOME.  The closeout harness uses a
  // deliberately reduced PATH; discovery there could select an unrelated
  // `lohra` shim or try the package registry, neither of which is hermetic.
  const child = spawn(process.execPath, [TSX_CLI, LAUNCHER_SCRIPT], {
    cwd: input.home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  const stderrText = (): string => Buffer.concat(stderrChunks).toString("utf8");
  const stdoutText = (): string => Buffer.concat(stdoutChunks).toString("utf8");

  const bootTimeoutMs = input.bootTimeoutMs ?? 20_000;
  const port = await new Promise<number>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CANDIDATE_FAKE_BOOT_TIMEOUT after ${String(bootTimeoutMs)}ms; stderr so far: ${stderrText()}`,
        ),
      );
    }, bootTimeoutMs);

    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `CANDIDATE_FAKE_EXITED_BEFORE_BOOT code=${String(exitCode)} signal=${String(signal)} stderr=${stderrText()}`,
        ),
      );
    });

    // Self-unregisters on match: left attached via .on(), this would keep
    // firing on every LATER stderr write (see launch-oracle.ts's identical
    // fix for the full explanation) -- each stray refire calling
    // removeAllListeners("exit") again, silently wiping out whatever exit
    // listener kill() registers afterward.
    const checkForBootLine = (): void => {
      const match = BOOT_LINE_PATTERN.exec(stderrText());
      if (match !== null) {
        clearTimeout(timeout);
        child.removeAllListeners("exit");
        child.stderr.removeListener("data", checkForBootLine);
        resolvePromise(Number(match[1]));
      }
    };
    child.stderr.on("data", checkForBootLine);
  });

  return {
    port,
    pid: child.pid ?? -1,
    stderrText,
    stdoutText,
    // See launch-oracle.ts's identical kill() for why this escalates: a
    // graceful SIGINT shutdown can hang indefinitely if a ghost-turn
    // request (ADR-T12-02) is still "in flight" server-side when the
    // signal arrives.
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
