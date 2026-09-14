import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const remaining = MAX_OUTPUT_CODE_POINTS - Array.from(current).length;
  if (remaining <= 0) return current;
  return current + Array.from(chunk).slice(0, remaining).join("");
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

function shellInvocation(
  command: string,
  stdoutPath: string,
  stderrPath: string,
): Readonly<{ executable: string; args: readonly string[] }> {
  if (process.platform === "win32") {
    const executable = process.env.ComSpec ?? "cmd.exe";
    const wrapped = `(${command}) 1>${quoteWindows(stdoutPath)} 2>${quoteWindows(stderrPath)}`;
    return { executable, args: ["/d", "/s", "/c", wrapped] };
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
  const invocation = shellInvocation(command, stdoutPath, stderrPath);

  return await new Promise<string>((resolve) => {
    let ptyOutput = "";
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawnPty(invocation.executable, [...invocation.args], {
        cwd: cwd ?? process.cwd(),
        env: process.env,
        cols: 80,
        rows: 24,
        name: "xterm-256color",
      });
    } catch (error) {
      rmSync(captureRoot, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      resolve(toolError(`could not run command: ${detail}`, { command }));
      return;
    }
    child.onData((chunk) => {
      ptyOutput = appendBounded(ptyOutput, chunk);
    });
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    child.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const stdout = existsSync(stdoutPath)
        ? appendBounded("", readFileSync(stdoutPath, "utf8"))
        : "";
      const stderr = existsSync(stderrPath)
        ? appendBounded("", readFileSync(stderrPath, "utf8"))
        : ptyOutput;
      rmSync(captureRoot, { recursive: true, force: true });
      if (timedOut) {
        resolve(toolError(`command timed out after ${timeoutLabel(args, timeout)}s`, { command }));
        return;
      }
      resolve(toolResult(undefined, { stdout, stderr, exit_code: exitCode }));
    });
  });
}
