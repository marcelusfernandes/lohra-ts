// Spawns the REAL TypeScript `dashboard` command as a genuinely separate
// process (not in-process/TestClient -- assertion 67, and the
// [processo-ts] evidence class this ticket's lifecycle scenarios require).
// Runs against source via tsx rather than the packaged dist/ binary; the
// packaged-binary path is a separate concern (assertion 73's pack-smoke),
// not what these protocol-level scenarios are proving.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(projectRoot, "src/cli.ts");

export interface LaunchedGatewayProcess {
  readonly port: number;
  readonly pid: number;
  stderrText(): string;
  stdoutText(): string;
  kill(
    signal?: NodeJS.Signals,
  ): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface LaunchCandidateInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly bootTimeoutMs?: number;
}

const BOOT_LINE_PATTERN = /^Lohra dashboard: http:\/\/127\.0\.0\.1:(\d+)\n$/mu;

export async function launchCandidateDashboard(
  input: LaunchCandidateInput,
): Promise<LaunchedGatewayProcess> {
  const child = spawn("npx", ["tsx", cliEntry, "dashboard", "--port", "0", ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

  const stderrText = (): string => Buffer.concat(stderrChunks).toString("utf8");
  const stdoutText = (): string => Buffer.concat(stdoutChunks).toString("utf8");

  const bootTimeoutMs = input.bootTimeoutMs ?? 10_000;
  const port = await new Promise<number>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CANDIDATE_BOOT_TIMEOUT after ${String(bootTimeoutMs)}ms; stderr so far: ${stderrText()}`,
        ),
      );
    }, bootTimeoutMs);

    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `CANDIDATE_EXITED_BEFORE_BOOT code=${String(exitCode)} signal=${String(signal)} stderr=${stderrText()}`,
        ),
      );
    });

    // Self-unregisters on match: left attached via .on(), this would keep
    // firing on every LATER stderr write for the rest of the process's
    // life (stderrText() is a cumulative buffer, so the match never stops
    // being true) -- each stray refire calling removeAllListeners("exit")
    // again, silently wiping out whatever exit listener kill() registers
    // afterward, so it never resolves even after the child has died.
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
    kill: (signal = "SIGINT") =>
      new Promise((resolvePromise) => {
        child.once("exit", (exitCode, exitSignal) => {
          resolvePromise({ exitCode, signal: exitSignal });
        });
        child.kill(signal);
      }),
  };
}
