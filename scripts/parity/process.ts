import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HarnessError } from "./errors.js";
import type { ProcessRecord } from "./types.js";

export interface ProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface PythonProcessOptions {
  readonly pythonExecutable: string;
  readonly driverPath?: string;
}

function limits(request: ProcessRequest): { timeout: number; maxBuffer: number } {
  return {
    timeout: request.timeoutMs ?? 10_000,
    maxBuffer: request.maxOutputBytes ?? 1_048_576,
  };
}

function spawnFailure(error: Error | undefined, label: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    throw new HarnessError("PROCESS_TIMEOUT", `${label} exceeded its declared timeout`, {
      cause: error,
    });
  }
  if (code === "ENOBUFS") {
    throw new HarnessError("PROCESS_OUTPUT_LIMIT", `${label} exceeded its output bound`, {
      cause: error,
    });
  }
  throw new HarnessError(
    "PROCESS_SPAWN",
    `${label} failed to spawn: ${error?.message ?? "unknown error"}`,
    {
      cause: error,
    },
  );
}

export function runTypeScriptProcess(request: ProcessRequest): ProcessRecord {
  const bounded = limits(request);
  const result = spawnSync(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: { ...request.environment },
    encoding: "buffer",
    shell: false,
    timeout: bounded.timeout,
    maxBuffer: bounded.maxBuffer,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    spawnFailure(result.error, "TypeScript adapter target");
  }
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout.toString("base64"),
    stderr: result.stderr.toString("base64"),
  };
}

export function runPythonProcess(
  request: ProcessRequest,
  options: PythonProcessOptions,
): ProcessRecord {
  const bounded = limits(request);
  const driverPath =
    options.driverPath ?? fileURLToPath(new URL("./python_runner.py", import.meta.url));
  const input = JSON.stringify({
    executable: request.executable,
    argv: request.argv,
    cwd: request.cwd,
    environment: request.environment,
    timeoutMs: bounded.timeout,
    maxOutputBytes: bounded.maxBuffer,
  });
  const result = spawnSync(options.pythonExecutable, [driverPath], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", PYTHONUTF8: "1" },
    shell: false,
    timeout: bounded.timeout,
    maxBuffer: bounded.maxBuffer * 3 + 65_536,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    spawnFailure(result.error, "Python adapter driver");
  }
  if (result.status !== 0) {
    throw new HarnessError(
      "PYTHON_DRIVER_EXIT",
      `Python adapter driver exited ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new HarnessError("PYTHON_DRIVER_PROTOCOL", "Python adapter returned invalid JSON", {
      cause: error,
    });
  }
  if (typeof response !== "object" || response === null) {
    throw new HarnessError("PYTHON_DRIVER_PROTOCOL", "Python adapter returned a non-object");
  }
  const object = response as Record<string, unknown>;
  if (typeof object.error === "object" && object.error !== null) {
    const detail = object.error as Record<string, unknown>;
    const code = typeof detail.code === "string" ? detail.code : "PYTHON_TARGET_ERROR";
    const message =
      typeof detail.message === "string" ? detail.message : "Python adapter target failed";
    throw new HarnessError(code, message);
  }
  if (!(
    (typeof object.exitCode === "number" || object.exitCode === null) &&
    (typeof object.signal === "string" || object.signal === null) &&
    typeof object.stdout === "string" &&
    typeof object.stderr === "string"
  )) {
    throw new HarnessError("PYTHON_DRIVER_PROTOCOL", "Python adapter response shape is invalid");
  }
  return {
    exitCode: object.exitCode,
    signal: object.signal,
    stdout: object.stdout,
    stderr: object.stderr,
  };
}
