import process from "node:process";

import {
  checkUpdate,
  defaultCommandRunner,
  performUpdate,
  reinstall,
  resolveInstalledRepo,
  type CommandRunner,
  type UpdateResult,
} from "../self-update/index.js";
import { readInstalledVersion, runRegistryUpdate, type RegistryFetch } from "./update-registry.js";

export interface UpdateCommandOptions {
  readonly check: boolean;
  readonly reinstall: boolean;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly repo?: string | null;
  readonly runner?: CommandRunner;
  /** Só usados fora de um checkout git (`repo === null`) — issue #533. */
  readonly yes?: boolean;
  readonly fetchImpl?: RegistryFetch;
  readonly currentVersion?: string;
}

function writeResult(value: UpdateResult, options: UpdateCommandOptions): number {
  (value.ok ? options.stdout : options.stderr)(`${value.message}\n`);
  return value.ok ? 0 : 2;
}

/** Sem `.git`, não há repositório para consultar — o contrato vira o do
 * registry npm (`update-registry.ts`, issue #533). `readInstalledVersion`
 * pode lançar (package.json ausente ou sem `version`); fail-closed em vez de
 * deixar a exceção escapar sem exit code. */
function runOutsideGitCheckout(options: UpdateCommandOptions): Promise<number> {
  let currentVersion: string;
  try {
    currentVersion = options.currentVersion ?? readInstalledVersion();
  } catch (error) {
    options.stderr(
      `could not determine the installed lohra-ts version: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return Promise.resolve(1);
  }
  return runRegistryUpdate({
    check: options.check,
    yes: options.yes ?? false,
    currentVersion,
    fetchImpl: options.fetchImpl ?? fetch,
    runner: options.runner ?? defaultCommandRunner,
    cwd: process.cwd(),
    stdout: options.stdout,
    stderr: options.stderr,
  });
}

export function runUpdate(options: UpdateCommandOptions): number | Promise<number> {
  const repo = options.repo === undefined ? resolveInstalledRepo() : options.repo;
  if (repo === null) {
    return runOutsideGitCheckout(options);
  }
  const runner = options.runner;
  const value = options.check ? checkUpdate(repo, runner) : performUpdate(repo, runner);
  const code = writeResult(value, options);
  if (code !== 0 || !value.reinstallRecommended) return code;
  if (!options.reinstall) {
    options.stdout("Dependencies changed — run `npm install` in the Lohra checkout.\n");
    return 0;
  }
  const installed = reinstall(repo, runner);
  if (installed.code !== 0) {
    options.stderr(`npm reinstall failed: ${installed.stderr || installed.stdout}\n`);
    return 2;
  }
  options.stdout("Dependencies reinstalled. Restart Lohra to apply the update.\n");
  return 0;
}
