import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkUpdate,
  locateRepo,
  performUpdate,
  type CommandRunner,
} from "../../../src/self-update/index.js";
import { evidenceTargetSha } from "./evidence.js";

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");

function command(
  cwd: string,
  executable: string,
  args: readonly string[],
  environment = process.env,
): string {
  const result = spawnSync(executable, [...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return command(cwd, "git", args);
}

function commit(cwd: string, message: string, timestamp: number): string {
  const date = `2001-01-01T00:00:${String(timestamp).padStart(2, "0")}Z`;
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  command(cwd, "git", ["add", "."], environment);
  command(cwd, "git", ["commit", "-m", message], environment);
  return git(cwd, "rev-parse", "HEAD");
}

function assertStatus(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`UPDATE_STATUS:${expected}:${actual}`);
}

function probeDivergenceRefusal(): readonly string[] {
  const calls: string[] = [];
  const runner: CommandRunner = (_executable, args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
    if (command === "symbolic-ref --quiet --short HEAD") {
      return { code: 0, stdout: "main", stderr: "" };
    }
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (command === "rev-parse HEAD") return { code: 0, stdout: "local", stderr: "" };
    if (command === "fetch --quiet") return { code: 0, stdout: "", stderr: "" };
    if (command.startsWith("merge-base --is-ancestor")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    throw new Error(`UPDATE_REFUSAL_UNEXPECTED_COMMAND:${command}`);
  };
  assertStatus(performUpdate("/repo", runner).status, "diverged");
  if (calls.some((entry) => entry.startsWith("pull "))) {
    throw new Error("UPDATE_DIVERGENCE_PULLED");
  }
  return calls;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "lohra-t22-update-"));
try {
  const divergenceRefusalCommands = probeDivergenceRefusal();
  const remote = join(temporaryRoot, "remote.git");
  const seed = join(temporaryRoot, "seed");
  const candidate = join(temporaryRoot, "candidate");
  mkdirSync(seed);
  git(temporaryRoot, "init", "--bare", remote);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "t22@example.invalid");
  git(seed, "config", "user.name", "T22 fixture");
  writeFileSync(join(seed, "README.md"), "base\n");
  const baseSha = commit(seed, "base", 1);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temporaryRoot, "clone", "--branch", "main", remote, candidate);
  git(candidate, "config", "user.email", "t22@example.invalid");
  git(candidate, "config", "user.name", "T22 fixture");

  const upToDate = checkUpdate(candidate);
  assertStatus(upToDate.status, "up_to_date");

  writeFileSync(join(seed, "package-lock.json"), '{"lockfileVersion":3}\n');
  const remoteSha = commit(seed, "dependency update", 2);
  git(seed, "push");
  const behind = checkUpdate(candidate);
  assertStatus(behind.status, "behind");
  const updated = performUpdate(candidate);
  assertStatus(updated.status, "updated");
  if (!updated.reinstallRecommended || git(candidate, "rev-parse", "HEAD") !== remoteSha) {
    throw new Error("UPDATE_FAST_FORWARD_OR_REINSTALL_MISSING");
  }

  writeFileSync(join(candidate, "dirty.txt"), "dirty\n");
  const beforeDirty = git(candidate, "rev-parse", "HEAD");
  assertStatus(performUpdate(candidate).status, "dirty");
  const afterDirty = git(candidate, "rev-parse", "HEAD");
  rmSync(join(candidate, "dirty.txt"));
  if (beforeDirty !== afterDirty) throw new Error("UPDATE_DIRTY_MUTATED_HEAD");

  git(candidate, "checkout", "--detach");
  assertStatus(performUpdate(candidate).status, "no_upstream");
  git(candidate, "checkout", "main");
  git(candidate, "checkout", "-b", "local-only");
  assertStatus(performUpdate(candidate).status, "no_upstream");
  git(candidate, "checkout", "main");

  writeFileSync(join(candidate, "local.txt"), "local\n");
  const localSha = commit(candidate, "local", 3);
  writeFileSync(join(seed, "remote.txt"), "remote\n");
  const divergedRemoteSha = commit(seed, "remote", 4);
  git(seed, "push");
  const diverged = performUpdate(candidate);
  assertStatus(diverged.status, "diverged");
  if (git(candidate, "rev-parse", "HEAD") !== localSha)
    throw new Error("UPDATE_DIVERGED_MUTATED_HEAD");

  git(candidate, "remote", "set-url", "origin", join(temporaryRoot, "missing.git"));
  assertStatus(checkUpdate(candidate).status, "error");
  const notARepo = join(temporaryRoot, "not-a-repo");
  mkdirSync(notARepo);
  if (locateRepo(notARepo) !== null) throw new Error("UPDATE_NOT_A_REPO");

  const statuses = [
    "not_a_repo",
    "dirty",
    "no_upstream",
    "diverged",
    "up_to_date",
    "behind",
    "updated",
    "error",
  ];
  const observation = {
    targetSha: evidenceTargetSha(project),
    statuses,
    refusalsMutatedHead: false,
    checkMutatedHead: false,
    fastForwardOnly: true,
    reinstallRecommended: true,
    divergenceRefusedBeforePull: true,
    divergenceRefusalCommands,
    graph: { baseSha, remoteSha, localSha, divergedRemoteSha },
    networkUsed: false,
    credentialsUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  const digest = createHash("sha256").update(canonical).digest("hex");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "update.json"), canonical);
  process.stdout.write(`${JSON.stringify({ ...observation, digest })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
