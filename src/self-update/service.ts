import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultCommandRunner,
  locateRepo,
  runGit,
  type CommandRunner,
  type CommandResult,
} from "./repo.js";

export type UpdateStatus =
  | "not_a_repo"
  | "dirty"
  | "no_upstream"
  | "diverged"
  | "up_to_date"
  | "behind"
  | "updated"
  | "error";

export interface UpdateResult {
  readonly status: UpdateStatus;
  readonly ok: boolean;
  readonly message: string;
  readonly changedFiles: readonly string[];
  readonly reinstallRecommended: boolean;
  readonly restartRequired: boolean;
  readonly oldSha?: string;
  readonly newSha?: string;
}

const OK = new Set<UpdateStatus>(["up_to_date", "behind", "updated"]);
const REINSTALL_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);

function result(
  status: UpdateStatus,
  message: string,
  extra: Partial<Omit<UpdateResult, "status" | "ok" | "message">> = {},
): UpdateResult {
  return {
    status,
    ok: OK.has(status),
    message,
    changedFiles: extra.changedFiles ?? [],
    reinstallRecommended: extra.reinstallRecommended ?? false,
    restartRequired: extra.restartRequired ?? false,
    ...(extra.oldSha === undefined ? {} : { oldSha: extra.oldSha }),
    ...(extra.newSha === undefined ? {} : { newSha: extra.newSha }),
  };
}

function failure(command: string, value: CommandResult): Error {
  const detail = value.stderr || value.stdout || `${command} failed`;
  const suffix = value.timedOut ? " (timed out)" : value.truncated ? " (output truncated)" : "";
  return new Error(`${detail}${suffix}`);
}

function gitText(runner: CommandRunner, repo: string, args: readonly string[]): string {
  const command = runGit(runner, repo, args);
  if (command.code !== 0) throw failure(`git ${args.join(" ")}`, command);
  return command.stdout;
}

function branchAndUpstream(
  runner: CommandRunner,
  repo: string,
): { readonly branch: string; readonly upstream: string } | UpdateResult {
  const branch = runGit(runner, repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.stdout === "") {
    return result("no_upstream", "HEAD is detached — checkout a branch to update.");
  }
  const upstream = runGit(runner, repo, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upstream.code !== 0 || upstream.stdout === "") {
    return result("no_upstream", `no upstream configured for branch '${branch.stdout}'.`);
  }
  return { branch: branch.stdout, upstream: upstream.stdout };
}

export function resolveInstalledRepo(moduleUrl: string = import.meta.url): string | null {
  return locateRepo(dirname(fileURLToPath(moduleUrl)));
}

export function checkUpdate(
  repo: string,
  runner: CommandRunner = defaultCommandRunner,
): UpdateResult {
  const tracking = branchAndUpstream(runner, repo);
  if ("status" in tracking) return tracking;
  try {
    const fetched = runGit(runner, repo, ["fetch", "--quiet"]);
    if (fetched.code !== 0)
      return result(
        "error",
        `could not check for updates: ${failure("git fetch", fetched).message}`,
      );
    const count = Number(gitText(runner, repo, ["rev-list", "--count", "HEAD..@{u}"]));
    if (!Number.isSafeInteger(count) || count < 0) {
      return result("error", "could not check for updates: unexpected rev-list output");
    }
    return count === 0
      ? result("up_to_date", `${tracking.branch} is up to date.`)
      : result(
          "behind",
          `${tracking.branch} is ${String(count)} commit(s) behind — run \`lohra update\` to apply.`,
        );
  } catch (error) {
    return result(
      "error",
      `could not check for updates: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function performUpdate(
  repo: string,
  runner: CommandRunner = defaultCommandRunner,
): UpdateResult {
  try {
    const dirty = gitText(runner, repo, ["status", "--porcelain"]);
    if (dirty !== "") {
      return result(
        "dirty",
        "working tree has uncommitted changes — commit or stash before updating.",
      );
    }
    const tracking = branchAndUpstream(runner, repo);
    if ("status" in tracking) return tracking;
    const oldSha = gitText(runner, repo, ["rev-parse", "HEAD"]);
    const fetched = runGit(runner, repo, ["fetch", "--quiet"]);
    if (fetched.code !== 0) {
      return result("error", `git fetch failed:\n${fetched.stderr || fetched.stdout}`);
    }
    const behindOrEqual = runGit(runner, repo, ["merge-base", "--is-ancestor", "HEAD", "@{u}"]);
    if (behindOrEqual.code > 1) {
      return result(
        "error",
        `could not classify upstream: ${behindOrEqual.stderr || behindOrEqual.stdout}`,
      );
    }
    if (behindOrEqual.code === 1) {
      const ahead = runGit(runner, repo, ["merge-base", "--is-ancestor", "@{u}", "HEAD"]);
      if (ahead.code > 1) {
        return result("error", `could not classify upstream: ${ahead.stderr || ahead.stdout}`);
      }
      if (ahead.code === 1) {
        return result(
          "diverged",
          `${tracking.branch} has diverged from its upstream — resolve manually.`,
        );
      }
      return result("up_to_date", `${tracking.branch} already contains its upstream.`, {
        oldSha,
        newSha: oldSha,
      });
    }
    const pulled = runGit(runner, repo, ["pull", "--ff-only"]);
    if (pulled.code !== 0) {
      return result("error", `git pull failed:\n${pulled.stderr || pulled.stdout}`);
    }
    const newSha = gitText(runner, repo, ["rev-parse", "HEAD"]);
    if (oldSha === newSha) {
      return result("up_to_date", `${tracking.branch} is already up to date.`, { oldSha, newSha });
    }
    const files = gitText(runner, repo, ["diff", "--name-only", `${oldSha}..${newSha}`])
      .split("\n")
      .filter(Boolean);
    const reinstallRecommended = files.some((file) =>
      REINSTALL_FILES.has(file.split("/").at(-1) ?? file),
    );
    return result(
      "updated",
      `updated ${tracking.branch}: ${String(files.length)} file(s) changed (${oldSha.slice(0, 7)}..${newSha.slice(0, 7)}).${reinstallRecommended ? " Dependencies changed (npm lockfile)." : ""}`,
      { changedFiles: files, reinstallRecommended, restartRequired: true, oldSha, newSha },
    );
  } catch (error) {
    return result(
      "error",
      `update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function reinstall(
  repo: string,
  runner: CommandRunner = defaultCommandRunner,
): CommandResult {
  return runner("npm", ["install"], repo);
}
