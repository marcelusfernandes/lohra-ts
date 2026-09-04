import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync } from "node:fs";

export const LOCK_PATH = "/tmp/lohra-parity-11434.lock";

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function guardCandidate(root: string): { sha: string; upstream: string } {
  const sha = git(root, "rev-parse", "HEAD");
  const porcelain = git(root, "status", "--porcelain");
  if (porcelain !== "") throw new Error(`candidate worktree is dirty:\n${porcelain}`);
  const upstream = git(root, "rev-parse", "@{upstream}");
  if (sha !== upstream) throw new Error(`candidate ${sha} is not pushed (${upstream})`);
  return { sha, upstream };
}

export function acquireLock(): void {
  for (const port of [11434, 8000]) {
    const probe = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    if (probe.status === 0) throw new Error(`shared port ${String(port)} is occupied`);
  }
  try {
    mkdirSync(LOCK_PATH);
  } catch (error) {
    throw new Error(`foreign parity lock exists at ${LOCK_PATH}`, { cause: error });
  }
}

export function releaseLock(): void {
  rmdirSync(LOCK_PATH);
}
