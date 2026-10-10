import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ResolveNpmOptions {
  readonly nodeExecutable?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunNpmOptions extends ResolveNpmOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

export function resolveNpmCli(options: ResolveNpmOptions = {}): string {
  const {
    nodeExecutable = process.execPath,
    platform = process.platform,
    env = process.env,
  } = options;
  const explicit = env.npm_execpath;
  const npmCli =
    explicit !== undefined && explicit !== ""
      ? resolve(explicit)
      : platform === "win32"
        ? join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js")
        : resolve(dirname(nodeExecutable), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  try {
    if (!statSync(npmCli).isFile()) throw new Error("npm CLI path is not a file");
  } catch (cause) {
    throw new Error(`NPM_CLI_NOT_FOUND:${npmCli}`, { cause });
  }
  return npmCli;
}

export function runNpmSync(
  argv: readonly string[],
  options: RunNpmOptions = {},
): SpawnSyncReturns<string> {
  const {
    nodeExecutable = process.execPath,
    platform = process.platform,
    env = process.env,
    cwd,
    timeoutMs,
    maxBuffer,
  } = options;
  const npmCli = resolveNpmCli({ nodeExecutable, platform, env });
  return spawnSync(nodeExecutable, [npmCli, ...argv], {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}
