import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { jsonNumberKind } from "./arguments.js";
import { toolError } from "./envelope.js";
import type { ToolArguments } from "./types.js";

const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const DIAGNOSTIC_LIMIT = 4 * 1024;
const START_DEADLINE = 5_000;
const CLEANUP_DEADLINE = 5_000;

export interface WindowsBridgeOptions {
  readonly signal?: AbortSignal;
  /** Test seam for protocol failures; terminalTool never supplies it. */
  readonly workerUrl?: URL;
  readonly nodeExecutable?: string;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executionDeadline(timeout: unknown): number | null {
  if (timeout === null) return null;
  if (timeout === undefined) return 30_000;
  if (typeof timeout === "boolean") return Number(timeout) * 1_000;
  if (typeof timeout === "number" && Number.isFinite(timeout)) {
    return Math.max(0, timeout * 1_000);
  }
  throw new TypeError(`invalid timeout: ${detail(timeout)}`);
}

function workerEntrypoint(options: WindowsBridgeOptions): { url: URL; source: boolean } {
  if (options.workerUrl !== undefined) return { url: options.workerUrl, source: false };
  const source = extname(fileURLToPath(import.meta.url)) === ".ts";
  return {
    url: new URL(
      source ? "./terminal-windows-worker.ts" : "./terminal-windows-worker.js",
      import.meta.url,
    ),
    source,
  };
}

function stopOwnedTree(child: ChildProcessWithoutNullStreams): string | null {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return null;
  if (process.platform !== "win32") {
    try {
      child.kill("SIGKILL");
      return null;
    } catch (error) {
      return `worker termination failed: ${detail(error)}`;
    }
  }
  // PID comes only from the ChildProcess started below. /T targets its descendants.
  const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    timeout: CLEANUP_DEADLINE,
    maxBuffer: DIAGNOSTIC_LIMIT,
    encoding: "utf8",
  });
  if (result.error !== undefined) return `worker tree termination failed: ${detail(result.error)}`;
  if (result.status !== 0) {
    return `worker tree termination failed (exit ${String(result.status)}): ${result.stderr.slice(0, 500)}`;
  }
  return null;
}

function fault(command: string, cause: string): string {
  return toolError(`could not finish command: Windows PTY bridge: ${cause}`, { command });
}

export async function runWindowsTerminalBridge(
  args: ToolArguments,
  options: WindowsBridgeOptions = {},
): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return toolError("missing required argument 'command' (string)");
  }
  let duration: number | null;
  let request: string;
  try {
    duration = executionDeadline(Object.hasOwn(args, "timeout") ? args.timeout : undefined);
    // The worker's process cwd is stable; its PTY still executes in the caller's cwd.
    request = JSON.stringify({
      version: 1,
      args: {
        command,
        cwd: args.cwd ?? process.cwd(),
        ...(Object.hasOwn(args, "timeout") ? { timeout: args.timeout } : {}),
      },
      timeoutKind: jsonNumberKind(args, "timeout"),
    });
    if (Buffer.byteLength(request, "utf8") + 1 > REQUEST_LIMIT) {
      return fault(command, "request exceeds 65536 bytes");
    }
  } catch (error) {
    return fault(command, `invalid request: ${detail(error)}`);
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    const entry = workerEntrypoint(options);
    const nodeArgs = entry.source ? ["--import", import.meta.resolve("tsx")] : [];
    nodeArgs.push(fileURLToPath(entry.url));
    const executable = options.nodeExecutable ?? process.execPath;
    child = spawn(executable, nodeArgs, {
      cwd: dirname(process.execPath),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    return fault(command, `worker spawn failed: ${detail(error)}`);
  }
  let output = Buffer.alloc(0);
  let diagnostics = Buffer.alloc(0);
  let ready = false;
  let stopping = false;
  let failure: string | null = null;
  let startTimer: NodeJS.Timeout | null = null;
  let runTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let resultTimer: NodeJS.Timeout | null = null;
  let resultSeen = false;
  return await new Promise<string>((resolve) => {
    const clearTimers = (): void => {
      if (startTimer !== null) clearTimeout(startTimer);
      if (runTimer !== null) clearTimeout(runTimer);
      if (cleanupTimer !== null) clearTimeout(cleanupTimer);
      if (resultTimer !== null) clearTimeout(resultTimer);
    };
    const stop = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      failure = reason;
      if (startTimer !== null) clearTimeout(startTimer);
      if (runTimer !== null) clearTimeout(runTimer);
      const killFailure = stopOwnedTree(child);
      if (killFailure !== null) failure += `; ${killFailure}`;
      cleanupTimer = setTimeout(() => {
        resolve(
          fault(command, `${failure ?? reason}; worker did not close within cleanup deadline`),
        );
      }, CLEANUP_DEADLINE);
    };
    startTimer = setTimeout(() => {
      stop("worker did not become ready within 5000ms");
    }, START_DEADLINE);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      if (output.length + chunk.length > RESPONSE_LIMIT) {
        stop("response exceeds 1048576 bytes");
        return;
      }
      output = Buffer.concat([output, chunk]);
      if (ready) {
        const first = output.indexOf(10);
        if (!resultSeen && first !== -1 && output.indexOf(10, first + 1) !== -1) {
          resultSeen = true;
          if (runTimer !== null) clearTimeout(runTimer);
          resultTimer = setTimeout(() => {
            stop("worker returned a result but did not exit within 5000ms");
          }, CLEANUP_DEADLINE);
        }
        return;
      }
      const newline = output.indexOf(10);
      if (newline === -1) return;
      try {
        const frame = JSON.parse(output.subarray(0, newline).toString("utf8")) as unknown;
        if (
          frame === null ||
          typeof frame !== "object" ||
          Array.isArray(frame) ||
          !("type" in frame)
        ) {
          throw new Error("invalid ready frame");
        }
        if (frame.type === "fault" && "message" in frame && typeof frame.message === "string") {
          stop(`worker failed: ${frame.message.slice(0, 500)}`);
          return;
        }
        if (Object.keys(frame).length !== 1 || frame.type !== "ready") {
          throw new Error("invalid ready frame");
        }
        ready = true;
        if (startTimer !== null) clearTimeout(startTimer);
        if (duration !== null) {
          runTimer = setTimeout(() => {
            stop(`worker exceeded execution deadline ${String(duration + CLEANUP_DEADLINE)}ms`);
          }, duration + CLEANUP_DEADLINE);
        }
        const second = output.indexOf(10, newline + 1);
        if (second !== -1) {
          resultSeen = true;
          if (runTimer !== null) clearTimeout(runTimer);
          resultTimer = setTimeout(() => {
            stop("worker returned a result but did not exit within 5000ms");
          }, CLEANUP_DEADLINE);
        }
      } catch (error) {
        stop(`malformed ready frame: ${detail(error)}`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = Buffer.concat([diagnostics, chunk]).subarray(0, DIAGNOSTIC_LIMIT);
    });
    child.stdin.on("error", (error) => {
      stop(`request write failed: ${detail(error)}`);
    });
    child.once("error", (error) => {
      stop(`worker spawn failed: ${detail(error)}`);
    });
    child.once("close", (code, signal) => {
      clearTimers();
      if (failure !== null) {
        resolve(fault(command, failure));
        return;
      }
      const lines = output.toString("utf8").trimEnd().split("\n");
      if (!ready || lines.length !== 2) {
        resolve(
          fault(
            command,
            `worker closed before complete protocol response (exit ${String(code)} / ${String(signal)}): ${diagnostics.toString("utf8").slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        const frame = JSON.parse(lines[1] ?? "") as unknown;
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
          throw new Error("invalid result frame");
        }
        if (
          "type" in frame &&
          frame.type === "fault" &&
          "message" in frame &&
          typeof frame.message === "string"
        ) {
          resolve(fault(command, `worker failed: ${frame.message.slice(0, 500)}`));
          return;
        }
        if (code !== 0 || signal !== null) {
          resolve(
            fault(
              command,
              `worker exited ${String(code)} / ${String(signal)}: ${diagnostics.toString("utf8").slice(0, 500)}`,
            ),
          );
          return;
        }
        if (
          !("type" in frame) ||
          frame.type !== "result" ||
          !("value" in frame) ||
          typeof frame.value !== "string" ||
          Object.keys(frame).length !== 2
        ) {
          throw new Error("invalid result frame");
        }
        const envelope = JSON.parse(frame.value) as unknown;
        if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
          throw new Error("invalid tool envelope");
        }
        const validError =
          "error" in envelope && typeof envelope.error === "string" && !("ok" in envelope);
        const validSuccess =
          "ok" in envelope &&
          envelope.ok === true &&
          "stdout" in envelope &&
          typeof envelope.stdout === "string" &&
          "stderr" in envelope &&
          typeof envelope.stderr === "string" &&
          "exit_code" in envelope &&
          typeof envelope.exit_code === "number" &&
          !("error" in envelope);
        if (!validError && !validSuccess) throw new Error("invalid tool envelope");
        resolve(frame.value);
      } catch (error) {
        resolve(fault(command, `malformed result: ${detail(error)}`));
      }
    });
    child.stdin.end(`${request}\n`);
  });
}
