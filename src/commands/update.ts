import {
  checkUpdate,
  performUpdate,
  reinstall,
  resolveInstalledRepo,
  type CommandRunner,
  type UpdateResult,
} from "../self-update/index.js";

export interface UpdateCommandOptions {
  readonly check: boolean;
  readonly reinstall: boolean;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly repo?: string | null;
  readonly runner?: CommandRunner;
}

function writeResult(value: UpdateResult, options: UpdateCommandOptions): number {
  (value.ok ? options.stdout : options.stderr)(`${value.message}\n`);
  return value.ok ? 0 : 2;
}

export function runUpdate(options: UpdateCommandOptions): number {
  const repo = options.repo === undefined ? resolveInstalledRepo() : options.repo;
  if (repo === null) {
    options.stderr(
      "Lohra is not installed from a git checkout — update with `npm install -g lohra-ts@latest`.\n",
    );
    return 2;
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
