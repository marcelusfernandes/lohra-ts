import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

/** Lança o shell da bancada preservando argv, stdin, cwd, ambiente e diagnóstico. */
export function spawnProcessShell(
  _args: readonly string[],
  _options: SpawnSyncOptionsWithStringEncoding,
  _shellPath?: string,
): SpawnSyncReturns<string> {
  throw new Error("not implemented");
}
