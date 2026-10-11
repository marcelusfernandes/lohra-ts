import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

const OUTPUT_LIMIT = 1_048_576;

function bounded(value: string): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= OUTPUT_LIMIT) return { value: value.trim(), truncated: false };
  return {
    value: bytes.subarray(0, OUTPUT_LIMIT).toString("utf8").trim(),
    truncated: true,
  };
}

export const defaultCommandRunner: CommandRunner = (executable, args, cwd) => {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    shell: false,
    env: process.env,
  });
  // spawnSync may omit both streams when launch fails, despite the string overload.
  const rawStdout: unknown = result.stdout;
  const rawStderr: unknown = result.stderr;
  const stdout = bounded(typeof rawStdout === "string" ? rawStdout : "");
  const stderrOutput = typeof rawStderr === "string" ? rawStderr : "";
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  // Keep the spawn cause at the front: maxBuffer may have already filled a stream.
  const diagnostic = spawnError ? `${spawnError.code ?? "spawn error"}: ${spawnError.message}` : "";
  const stderr = bounded([diagnostic, stderrOutput].filter(Boolean).join("\n"));
  return {
    code: result.status ?? 1,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(spawnError?.code === "ETIMEDOUT" ? { timedOut: true } : {}),
    ...(stdout.truncated || stderr.truncated || spawnError?.code === "ENOBUFS"
      ? { truncated: true }
      : {}),
  };
};

export function locateRepo(start: string): string | null {
  let current = realpathSync(resolve(start));
  while (dirname(current) !== current) {
    if (existsSync(resolve(current, ".git"))) return current;
    current = dirname(current);
  }
  return existsSync(resolve(current, ".git")) ? current : null;
}

export function runGit(
  runner: CommandRunner,
  repo: string,
  args: readonly string[],
): CommandResult {
  return runner("git", args, repo);
}
