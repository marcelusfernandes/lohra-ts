import type { SpawnSyncReturns } from "node:child_process";

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

export function resolveNpmCli(_options: ResolveNpmOptions = {}): string {
  throw new Error("not implemented: resolveNpmCli");
}

export function runNpmSync(
  _argv: readonly string[],
  _options: RunNpmOptions = {},
): SpawnSyncReturns<string> {
  throw new Error("not implemented: runNpmSync");
}
