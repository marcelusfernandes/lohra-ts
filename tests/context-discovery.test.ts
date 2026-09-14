// Issue #588 (épico #575, P12): hints adicionais de ambiente em
// `loadProjectContext` — plataforma, shell, versão de node e um snapshot de
// git (branch, branch default, status curto, commits recentes). Fail-open:
// sem git ou com falha/timeout de um comando, a chave correspondente some,
// nunca lança. Sem rede: só comandos git locais (`symbolic-ref`,
// `rev-parse`, `status`, `log`) — nunca `fetch`/`ls-remote`/`remote show`.
//
// `tests/context.test.ts` cobre o contrato geral de `loadProjectContext`
// (byte-compat de `discoverInstructions`, resolução de `project_root`); este
// arquivo cobre só o snapshot de ambiente que #588 acrescenta, com
// repositórios git reais e um `git` falso para o caso de timeout/falha —
// sem depender de `tests/helpers/controle-negativo-repo.ts` (fora dos
// `Files` desta issue).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectContext } from "../src/context/index.js";

const dirs: string[] = [];
const dir = (prefix = "lohra-context-discovery-"): string => {
  const value = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(value);
  return value;
};

afterEach(() => {
  for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
}

function initRepo(): string {
  const repo = dir();
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "prova@example.com"]);
  git(repo, ["config", "user.name", "Prova"]);
  return repo;
}

/** Um script shell marcado executável, usado como `git` falso via caminho
 * absoluto — nunca via PATH, para não afetar o resto do processo de teste. */
function fakeGitScript(body: string): string {
  const scriptsDir = dir("lohra-fake-git-");
  const path = join(scriptsDir, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("environment snapshot hints (#588)", () => {
  it("always includes platform and node, regardless of git", () => {
    const plain = dir();
    const { hints } = loadProjectContext(plain);
    expect(hints.platform).toBe(process.platform);
    expect(hints.node).toBe(process.version);
    expect(hints.shell).toBeDefined();
  });

  it("omits every git_* key outside a git repository, without throwing", () => {
    const plain = dir();
    const { hints } = loadProjectContext(plain);
    expect(hints).not.toHaveProperty("git_branch");
    expect(hints).not.toHaveProperty("git_default_branch");
    expect(hints).not.toHaveProperty("git_status");
    expect(hints).not.toHaveProperty("git_recent");
  });

  it("reports branch, status, and recent commits inside a real repository", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "first commit"]);
    writeFileSync(join(repo, "b.txt"), "dirty\n");

    const { hints } = loadProjectContext(repo);
    expect(hints.git_branch).toBe("main");
    expect(hints.git_status).toContain("b.txt");
    expect(hints.git_recent).toContain("first commit");
  });

  it("reports a clean git_status as 'clean' when there is nothing pending", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "first commit"]);

    const { hints } = loadProjectContext(repo);
    expect(hints.git_status).toBe("clean");
  });

  it("truncates git_status at 20 lines with a marker", () => {
    const repo = initRepo();
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(repo, `f${String(index)}.txt`), "x");
    }
    const { hints } = loadProjectContext(repo);
    const lines = (hints.git_status ?? "").split("\n");
    expect(lines.length).toBe(21);
    expect(lines[20]).toContain("more");
  });

  it("reports git_default_branch only when refs/remotes/origin/HEAD is set locally", () => {
    const withoutOrigin = initRepo();
    writeFileSync(join(withoutOrigin, "a.txt"), "one\n");
    git(withoutOrigin, ["add", "a.txt"]);
    git(withoutOrigin, ["commit", "-q", "-m", "first commit"]);
    expect(loadProjectContext(withoutOrigin).hints).not.toHaveProperty("git_default_branch");

    const withOrigin = initRepo();
    writeFileSync(join(withOrigin, "a.txt"), "one\n");
    git(withOrigin, ["add", "a.txt"]);
    git(withOrigin, ["commit", "-q", "-m", "first commit"]);
    git(withOrigin, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(loadProjectContext(withOrigin).hints.git_default_branch).toBe("main");
  });

  it("never throws and omits git_* keys when git times out (fail-open, bounded)", () => {
    const repo = initRepo();
    const slowGit = fakeGitScript("sleep 2");
    const started = Date.now();
    const { hints } = loadProjectContext(repo, undefined, slowGit);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(1500);
    expect(hints).not.toHaveProperty("git_branch");
    expect(hints).not.toHaveProperty("git_status");
    expect(hints).not.toHaveProperty("git_recent");
    expect(hints.platform).toBe(process.platform);
  });

  it("never throws and omits git_* keys when git exits non-zero", () => {
    const repo = initRepo();
    const brokenGit = fakeGitScript("exit 128");
    const { hints } = loadProjectContext(repo, undefined, brokenGit);
    expect(hints).not.toHaveProperty("git_branch");
    expect(hints).not.toHaveProperty("git_status");
    expect(hints).not.toHaveProperty("git_recent");
  });

  // Issue #648 (grupo A, item 7d de #637): `gitSnapshot` (discovery.ts:
  // 216-219) falls back to `rev-parse --short HEAD` only when `symbolic-ref
  // --short HEAD` fails -- true on a genuinely detached HEAD, never
  // exercised by any fixture above (every one commits straight onto
  // `main`). Every other test in this file pins ABSENCE of `git_branch`;
  // this one pins the fallback VALUE itself.
  it("falls back to the short commit SHA for git_branch on a detached HEAD", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "first commit"]);
    git(repo, ["checkout", "--detach", "-q"]);

    const shortSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    expect(shortSha.length).toBeGreaterThan(0);

    const { hints } = loadProjectContext(repo);
    expect(hints.git_branch).toBe(shortSha);
  });
});
