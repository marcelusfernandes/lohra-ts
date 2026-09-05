// Issue #62: helper `scripts/ci/lib/git.ts`, compartilhado pelos três
// `run.ts` (escopo, contratos, controle-negativo) — `-z`/`--no-renames` no
// diff (fail-open latente com caminho não-ASCII) e causa completa
// (spawn/exit/sinal/stderr) em toda falha, nunca um "falhou" genérico.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { causaGit, git, gitDiffNameStatus, gitDiffNames } from "../scripts/ci/lib/git.js";

const workdirs: string[] = [];
afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function gitCli(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

function novoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-lib-git-"));
  workdirs.push(dir);
  gitCli(dir, ["init", "-q", "-b", "main"]);
  gitCli(dir, ["config", "user.email", "prova@example.com"]);
  gitCli(dir, ["config", "user.name", "Prova"]);
  return dir;
}

function commitTudo(dir: string, mensagem: string): string {
  gitCli(dir, ["add", "-A"]);
  gitCli(dir, ["commit", "-q", "--allow-empty", "-m", mensagem]);
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return r.stdout.trim();
}

describe("git() — execução crua", () => {
  it("status/stdout/stderr de um comando bem-sucedido", () => {
    const dir = novoRepo();
    const r = git(dir, ["status", "--short"]);
    expect(r.status).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it("binário ausente: error definido, causaGit menciona ENOENT", () => {
    const dirVazio = mkdtempSync(join(tmpdir(), "ci-lib-git-path-vazio-"));
    workdirs.push(dirVazio);
    const r = git(process.cwd(), ["status"], { PATH: dirVazio });
    expect(r.status).not.toBe(0);
    expect(causaGit(r)).toContain("ENOENT");
  });
});

describe("gitDiffNames — -z, --no-renames, caminho não-ASCII", () => {
  it("lista os arquivos alterados entre dois commits", () => {
    const dir = novoRepo();
    writeFileSync(join(dir, "a.txt"), "1\n");
    const base = commitTudo(dir, "chore: base");
    writeFileSync(join(dir, "b.txt"), "2\n");
    const head = commitTudo(dir, "chore: head");

    expect(gitDiffNames(dir, base, head)).toEqual(["b.txt"]);
  });

  it("não trunca nem escapa um caminho não-ASCII (café.md) — fail-open corrigido (issue #62)", () => {
    const dir = novoRepo();
    const base = commitTudo(dir, "chore: base vazia");
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "café.md"), "x\n");
    const head = commitTudo(dir, "docs: adiciona café.md");

    const nomes = gitDiffNames(dir, base, head).map((n) => n.normalize("NFC"));
    expect(nomes).toEqual(["docs/reference/café.md".normalize("NFC")]);
  });

  it("lança com a causa completa quando o range é inválido", () => {
    const dir = novoRepo();
    commitTudo(dir, "chore: init");
    expect(() => gitDiffNames(dir, "0".repeat(40), "HEAD")).toThrow(/git diff/);
  });
});

describe("gitDiffNameStatus — pares status/arquivo via -z", () => {
  it("separa adição, modificação e remoção corretamente", () => {
    const dir = novoRepo();
    writeFileSync(join(dir, "existe.txt"), "1\n");
    writeFileSync(join(dir, "removido.txt"), "1\n");
    const base = commitTudo(dir, "chore: base");
    writeFileSync(join(dir, "existe.txt"), "2\n");
    writeFileSync(join(dir, "novo.txt"), "1\n");
    rmSync(join(dir, "removido.txt"));
    const head = commitTudo(dir, "chore: head");

    const alterados = [...gitDiffNameStatus(dir, base, head)].sort((a, b) =>
      a.arquivo.localeCompare(b.arquivo),
    );
    expect(alterados).toEqual([
      { status: "M", arquivo: "existe.txt" },
      { status: "A", arquivo: "novo.txt" },
      { status: "D", arquivo: "removido.txt" },
    ]);
  });
});
