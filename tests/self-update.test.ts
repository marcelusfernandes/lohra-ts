import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runUpdate } from "../src/commands/update.js";
import {
  checkUpdate,
  locateRepo,
  performUpdate,
  type CommandRunner,
} from "../src/self-update/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function runner(
  replies: Readonly<Record<string, readonly [number, string?, string?]>>,
  calls: string[] = [],
): CommandRunner {
  return (executable, args, cwd) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(`${cwd}:${key}`);
    const reply = Object.entries(replies).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (reply === undefined) throw new Error(`unexpected command: ${key}`);
    return { code: reply[0], stdout: reply[1] ?? "", stderr: reply[2] ?? "" };
  };
}

describe("self-update repository discovery", () => {
  it("walks from the installed module path and accepts a worktree .git file", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-update-locate-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    const nested = join(root, "dist", "commands");
    mkdirSync(nested, { recursive: true });
    expect(locateRepo(nested)).toBe(realpathSync(root));
  });
});

describe("self-update state machine", () => {
  it("reports check-only behind after fetch and never pulls", () => {
    const calls: string[] = [];
    const value = checkUpdate(
      "/repo",
      runner(
        {
          "git symbolic-ref": [0, "main"],
          "git rev-parse --abbrev-ref": [0, "origin/main"],
          "git fetch": [0],
          "git rev-list": [0, "3"],
        },
        calls,
      ),
    );
    expect(value).toMatchObject({ status: "behind", ok: true });
    expect(calls.some((call) => call.includes(" pull "))).toBe(false);
  });

  it("refuses dirty, detached and no-upstream states before pull", () => {
    expect(performUpdate("/repo", runner({ "git status": [0, " M src/x.ts"] }))).toMatchObject({
      status: "dirty",
      ok: false,
    });
    expect(
      performUpdate(
        "/repo",
        runner({ "git status": [0], "git symbolic-ref": [1, "", "detached"] }),
      ),
    ).toMatchObject({ status: "no_upstream", ok: false });
    expect(
      performUpdate(
        "/repo",
        runner({
          "git status": [0],
          "git symbolic-ref": [0, "main"],
          "git rev-parse --abbrev-ref": [1, "", "missing"],
        }),
      ),
    ).toMatchObject({ status: "no_upstream", ok: false });
  });

  it("refuses structural divergence before pull and classifies a later pull failure", () => {
    const divergenceCalls: string[] = [];
    const base = {
      "git status": [0, ""] as const,
      "git symbolic-ref": [0, "main"] as const,
      "git rev-parse --abbrev-ref": [0, "origin/main"] as const,
      "git rev-parse HEAD": [0, "old"] as const,
      "git fetch --quiet": [0] as const,
      "git merge-base --is-ancestor HEAD": [1] as const,
      "git merge-base --is-ancestor @{u}": [1] as const,
    };
    expect(
      performUpdate("/repo", runner(base, divergenceCalls)),
      "MUTATION_CAUSE:T22-updater-divergence-before-pull",
    ).toMatchObject({
      status: "diverged",
      reinstallRecommended: false,
    });
    expect(
      divergenceCalls.some((call) => call.includes(" pull ")),
      "MUTATION_CAUSE:T22-updater-divergence-before-pull",
    ).toBe(false);

    const failureCalls: string[] = [];
    expect(
      performUpdate(
        "/repo",
        runner(
          {
            ...base,
            "git merge-base --is-ancestor HEAD": [0],
            "git pull --ff-only": [1, "", "transport failed"],
          },
          failureCalls,
        ),
      ),
    ).toMatchObject({ status: "error" });
    expect(failureCalls.some((call) => call.includes(" pull "))).toBe(true);
  });

  it("reports changed files and requests npm reinstall for dependency manifests", () => {
    let shaCall = 0;
    const command: CommandRunner = (_executable, args) => {
      const key = args.join(" ");
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key.startsWith("symbolic-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (key.startsWith("rev-parse --abbrev-ref")) {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        shaCall += 1;
        return { code: 0, stdout: shaCall === 1 ? "oldsha1" : "newsha2", stderr: "" };
      }
      if (key === "fetch --quiet") return { code: 0, stdout: "", stderr: "" };
      if (key === "merge-base --is-ancestor HEAD @{u}") return { code: 0, stdout: "", stderr: "" };
      if (key === "pull --ff-only") return { code: 0, stdout: "updated", stderr: "" };
      if (key.startsWith("diff --name-only")) {
        return { code: 0, stdout: "src/x.ts\npackage-lock.json", stderr: "" };
      }
      throw new Error(`unexpected ${key}`);
    };
    expect(performUpdate("/repo", command)).toMatchObject({
      status: "updated",
      changedFiles: ["src/x.ts", "package-lock.json"],
      reinstallRecommended: true,
      restartRequired: true,
      oldSha: "oldsha1",
      newSha: "newsha2",
    });
  });
});

describe("update command", () => {
  it("gives an npm remedy outside a git checkout", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    expect(runUpdate({ check: false, reinstall: false, stdout, stderr, repo: null })).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("npm install -g lohra-ts@latest"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("reinstalls with npm executable plus argv and no shell", () => {
    const calls: string[] = [];
    let shaCall = 0;
    const command: CommandRunner = (executable, args, cwd) => {
      calls.push(`${executable}|${args.join("|")}|${cwd}`);
      const key = args.join(" ");
      if (executable === "npm") return { code: 0, stdout: "ok", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key.startsWith("symbolic-ref")) return { code: 0, stdout: "main", stderr: "" };
      if (key.startsWith("rev-parse --abbrev-ref"))
        return { code: 0, stdout: "origin/main", stderr: "" };
      if (key === "rev-parse HEAD") {
        shaCall += 1;
        return { code: 0, stdout: shaCall === 1 ? "old" : "new", stderr: "" };
      }
      if (key === "fetch --quiet") return { code: 0, stdout: "", stderr: "" };
      if (key === "merge-base --is-ancestor HEAD @{u}") return { code: 0, stdout: "", stderr: "" };
      if (key === "pull --ff-only") return { code: 0, stdout: "ok", stderr: "" };
      if (key.startsWith("diff --name-only"))
        return { code: 0, stdout: "package.json", stderr: "" };
      throw new Error(`unexpected ${key}`);
    };
    expect(
      runUpdate({
        check: false,
        reinstall: true,
        stdout: vi.fn(),
        stderr: vi.fn(),
        repo: "/repo",
        runner: command,
      }),
    ).toBe(0);
    expect(calls.at(-1)).toBe("npm|install|/repo");
  });
});
