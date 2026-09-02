import { spawn } from "node:child_process";

import { ApprovalManager, approval } from "./approval.js";
import { pythonNumberKind } from "./arguments.js";
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
  if (typeof timeout === "boolean") return timeout ? "True" : "False";
  if (typeof timeout === "number") {
    if (pythonNumberKind(args, "timeout") === "float" && Number.isInteger(timeout)) {
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
    return toolError("command was not approved by the user", { command });
  }

  const timeout = Object.hasOwn(args, "timeout") ? args.timeout : DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutMilliseconds(timeout);
  const cwd = args.cwd === undefined || args.cwd === null ? undefined : renderArgument(args.cwd);

  return await new Promise<string>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: Error | null = null;
    const child = spawn(command, {
      shell: true,
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);
    child.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      if (timedOut) {
        resolve(toolError(`command timed out after ${timeoutLabel(args, timeout)}s`, { command }));
        return;
      }
      if (spawnError !== null) {
        resolve(toolError(`could not run command: ${spawnError.message}`, { command }));
        return;
      }
      resolve(toolResult(undefined, { stdout, stderr, exit_code: code ?? 0 }));
    });
  });
}

export const TERMINAL_SCHEMA = {
  description:
    "Run a shell command on the local machine and return stdout, stderr, and the exit code. Dangerous commands require user approval.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout: { type: "integer", description: "Timeout in seconds (default 30)" },
      cwd: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  },
} as const;
