import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const prepare = join(root, "scripts", "prepare.mjs");
const prePushSource = join(root, ".claude", "hooks", "git-pre-push");
const shellInstaller = join(root, ".claude", "hooks", "instalar-git-hooks.sh");

function git(dir: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd: dir, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "lohra prepare & spaces "));
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(prePushSource, join(dir, ".claude", "hooks", "git-pre-push"));
  copyFileSync(shellInstaller, join(dir, ".claude", "hooks", "instalar-git-hooks.sh"));
  return dir;
}

function fakeLefthook(dir: string): string {
  const marker = join(dir, "lefthook-argv.json");
  const entry = join(dir, "node_modules", "lefthook", "bin", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));
     process.exit(Number(process.env.FAKE_LEFTHOOK_EXIT ?? 0));`,
  );
  return marker;
}

function runPrepare(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.LOHRA_SKIP_PREPARE;
  return spawnSync(process.execPath, [prepare], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function installedPrePush(dir: string): string {
  return resolve(dir, git(dir, ["rev-parse", "--git-path", "hooks/pre-push"]));
}

describe("prepare portable hooks", () => {
  it("installs pre-push and runs the JS lefthook entry without shell wrappers", () => {
    const dir = checkout();
    try {
      const marker = fakeLefthook(dir);
      const first = runPrepare(dir);
      expect(first.error).toBeUndefined();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe("");
      expect(readFileSync(installedPrePush(dir), "utf8")).toBe(readFileSync(prePushSource, "utf8"));
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["install", "pre-commit"]);

      const second = runPrepare(dir);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(installedPrePush(dir), "utf8")).toBe(readFileSync(prePushSource, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps absent optional lefthook separate from a failed pre-push installation", () => {
    const dir = checkout();
    try {
      const result = runPrepare(dir);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(installedPrePush(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the hook's nonzero status and exits nonzero", () => {
    const dir = checkout();
    try {
      fakeLefthook(dir);
      const result = runPrepare(dir, { FAKE_LEFTHOOK_EXIT: "7" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/lefthook.*exit 7/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing pre-push source instead of treating it as success", () => {
    const dir = checkout();
    try {
      rmSync(join(dir, ".claude", "hooks", "git-pre-push"));
      const result = runPrepare(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/pre-push.*ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing Git executable with its spawn cause", () => {
    const dir = checkout();
    try {
      const result = runPrepare(dir, { PATH: join(dir, "no-executables") });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/git hooks path.*ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs in the shared Git hooks directory of a temporary linked worktree", () => {
    const dir = checkout();
    const linkedRoot = mkdtempSync(join(tmpdir(), "lohra-linked-hooks-"));
    const linked = join(linkedRoot, "linked worktree");
    try {
      git(dir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      git(dir, ["worktree", "add", "--detach", linked]);
      mkdirSync(join(linked, ".claude", "hooks"), { recursive: true });
      copyFileSync(prePushSource, join(linked, ".claude", "hooks", "git-pre-push"));
      copyFileSync(shellInstaller, join(linked, ".claude", "hooks", "instalar-git-hooks.sh"));
      const result = runPrepare(linked);
      expect(result.status, result.stderr).toBe(0);
      expect(installedPrePush(linked)).toBe(installedPrePush(dir));
      expect(readFileSync(installedPrePush(dir), "utf8")).toBe(readFileSync(prePushSource, "utf8"));
    } finally {
      if (existsSync(linked)) git(dir, ["worktree", "remove", "--force", linked]);
      rmSync(linkedRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
