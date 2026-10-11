import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { spawn as spawnPty } from "node-pty";

import { ApprovalManager, approval, detectDangerousCommand } from "./approval.js";
import { jsonNumberKind } from "./arguments.js";
import { toolError, toolResult } from "./envelope.js";
import type { ToolArguments } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_CODE_POINTS = 50_000;

export interface TerminalOptions {
  readonly approvalManager?: ApprovalManager;
}

function appendBounded(current: string, chunk: string): string {
  let remaining = MAX_OUTPUT_CODE_POINTS - Array.from(current).length;
  if (remaining <= 0) return current;
  let added = "";
  for (const point of chunk) {
    if (remaining === 0) break;
    added += point;
    remaining -= 1;
  }
  return current + added;
}

function readBoundedFile(path: string): string {
  const fd = openSync(path, "r");
  let output = "";
  let failure: string | null = null;
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(8_192);
    while (Array.from(output).length < MAX_OUTPUT_CODE_POINTS) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        output = appendBounded(output, decoder.end());
        break;
      }
      output = appendBounded(output, decoder.write(buffer.subarray(0, bytes)));
    }
  } catch (error) {
    failure = `read failed: ${errorDetail(error)}`;
  }
  try {
    closeSync(fd);
  } catch (error) {
    const closeFailure = `close failed: ${errorDetail(error)}`;
    failure = failure === null ? closeFailure : `${failure}; ${closeFailure}`;
  }
  if (failure !== null) throw new Error(failure);
  return output;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function timeoutLabel(args: ToolArguments, timeout: unknown): string {
  if (typeof timeout === "boolean") return JSON.stringify(timeout);
  if (typeof timeout === "number") {
    if (jsonNumberKind(args, "timeout") === "float" && Number.isInteger(timeout)) {
      return timeout.toFixed(1);
    }
    return String(timeout);
  }
  return renderArgument(timeout);
}

function timeoutMilliseconds(timeout: unknown): number | null {
  if (timeout === null) return null;
  if (typeof timeout === "boolean") return Number(timeout) * 1000;
  if (typeof timeout === "number") return Math.max(0, timeout * 1000);
  throw new TypeError(`invalid timeout: ${renderArgument(timeout)}`);
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function terminalShellInvocation(
  command: string,
  stdoutPath: string,
  stderrPath: string,
  platform: NodeJS.Platform = process.platform,
): Readonly<{ executable: string; args: string | string[] }> {
  if (platform === "win32") {
    const executable = process.env.ComSpec ?? "cmd.exe";
    const wrapped = `(${command}) 1>${quoteWindows(stdoutPath)} 2>${quoteWindows(stderrPath)}`;
    // node-pty escapes embedded quotes when given argv[] on Windows. cmd.exe
    // then sees invalid redirection syntax. Its command-line overload leaves
    // the already quoted redirection paths intact.
    return { executable, args: `/d /s /c ${wrapped}` };
  }
  const executable = process.env.SHELL ?? "/bin/sh";
  const wrapped = `(${command}) 1>${quotePosix(stdoutPath)} 2>${quotePosix(stderrPath)}`;
  return { executable, args: ["-lc", wrapped] };
}

export async function terminalTool(
  args: ToolArguments,
  options: TerminalOptions = {},
): Promise<string> {
  const command = args.command;
  if (!command || typeof command !== "string") {
    return toolError("missing required argument 'command' (string)");
  }
  const approvalManager = options.approvalManager ?? approval;
  if (!approvalManager.require(command)) {
    // No mode of this runtime prompts a human for approval (issue #577): the
    // refusal below is the dangerous-command policy denying by itself, not a
    // person who declined. It is final for this session -- report the
    // blocker instead of rephrasing or retrying the same command.
    // ApprovalManager.require() only returns false for a command
    // detectDangerousCommand() itself flagged, so this call always finds one.
    const dangerous = detectDangerousCommand(command);
    if (dangerous === null) {
      throw new Error(
        `dangerous-command policy denied a command detectDangerousCommand() does not flag: ${command}`,
      );
    }
    return toolError(`command refused by the dangerous-command policy (${dangerous.description})`, {
      command,
      refusal: "final",
    });
  }

  const timeout = Object.hasOwn(args, "timeout") ? args.timeout : DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutMilliseconds(timeout);
  const cwd = args.cwd === undefined || args.cwd === null ? undefined : renderArgument(args.cwd);

  const captureRoot = mkdtempSync(join(tmpdir(), "lohra-terminal-"));
  const stdoutPath = join(captureRoot, "stdout");
  const stderrPath = join(captureRoot, "stderr");
  const invocation = terminalShellInvocation(command, stdoutPath, stderrPath);

  return await new Promise<string>((resolve) => {
    let ptyOutput = "";
    let timedOut = false;
    let settled = false;
    let killRequested = false;
    let child;
    try {
      child = spawnPty(invocation.executable, invocation.args, {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        cols: 80,
        rows: 24,
        name: "xterm-256color",
      });
    } catch (error) {
      let message = `could not run command: ${errorDetail(error)}`;
      try {
        rmSync(captureRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        message += `; capture cleanup failed: ${errorDetail(cleanupError)}`;
      }
      resolve(toolError(message, { command }));
      return;
    }
    const dataSubscription = child.onData((chunk) => {
      ptyOutput = appendBounded(ptyOutput, chunk);
    });
    let timer: NodeJS.Timeout | null = null;
    let exitWatchdog: NodeJS.Timeout | null = null;
    let exitSubscription: { dispose(): void } | null = null;
    const finish = (exitCode: number | null, lifecycleFailure?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (exitWatchdog !== null) clearTimeout(exitWatchdog);
      const failures = lifecycleFailure === undefined ? [] : [lifecycleFailure];
      const attempt = (label: string, action: () => void): void => {
        try {
          action();
        } catch (error) {
          failures.push(`${label}: ${errorDetail(error)}`);
        }
      };
      attempt("data listener cleanup failed", () => {
        dataSubscription.dispose();
      });
      const subscription = exitSubscription;
      if (subscription !== null) {
        attempt("exit listener cleanup failed", () => {
          subscription.dispose();
        });
      }
      let stdout = "";
      let stderr = ptyOutput;
      if (existsSync(stdoutPath)) {
        attempt("stdout capture read failed", () => {
          stdout = readBoundedFile(stdoutPath);
        });
      }
      if (existsSync(stderrPath)) {
        attempt("stderr capture read failed", () => {
          stderr = readBoundedFile(stderrPath);
        });
      }
      // node-pty closes the ConPTY socket on natural exit but retains its
      // output worker. kill() after onExit disposes that worker as well.
      if (process.platform === "win32" && !killRequested) {
        killRequested = true;
        attempt("PTY cleanup failed", () => {
          child.kill();
        });
      }
      attempt("capture cleanup failed", () => {
        rmSync(captureRoot, { recursive: true, force: true });
      });
      if (timedOut) {
        const cause = failures.length === 0 ? "" : `; ${failures.join("; ")}`;
        resolve(
          toolError(`command timed out after ${timeoutLabel(args, timeout)}s${cause}`, { command }),
        );
        return;
      }
      if (failures.length > 0 || exitCode === null) {
        resolve(toolError(`could not finish command: ${failures.join("; ")}`, { command }));
        return;
      }
      resolve(toolResult(undefined, { stdout, stderr, exit_code: exitCode }));
    };
    exitSubscription = child.onExit(({ exitCode }) => {
      finish(exitCode);
    });
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        killRequested = true;
        try {
          child.kill();
        } catch (error) {
          finish(null, `PTY termination failed: ${errorDetail(error)}`);
          return;
        }
        if (!settled) {
          exitWatchdog = setTimeout(() => {
            finish(null, "PTY did not exit after termination");
          }, 5_000);
        }
      }, timeoutMs);
    }
  });
}
