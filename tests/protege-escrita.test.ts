// Bancada do hook PreToolUse(Edit|Write) `.claude/hooks/protege-escrita.sh` (issue #61).
//
// Monta um repositório temporário com `.claude/settings.json`, `docs/reference/`
// e um `lohra/` que é repo git ANINHADO (como o checkout do Python), mais um
// worktree de agente em `.claude/worktrees/w`. A raiz das regras é o toplevel git
// mais INTERNO, a partir do ALVO, que contenha `.claude/settings.json`: dentro do
// worktree a raiz é o worktree (senão `.claude/worktrees/w/docs/reference/x` não
// casaria), dentro de `lohra/` a raiz é o projeto (lohra/ não tem settings).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("../.claude/hooks/protege-escrita.sh", import.meta.url));

function git(cwd: string, ...args: readonly string[]): void {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

interface HookRun {
  readonly status: number | null;
  readonly stderr: string;
}

function escrever(cwd: string, filePath: string, toolName = "Write"): HookRun {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  const r = spawnSync("sh", [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath }, cwd }),
    encoding: "utf8",
    env,
  });
  return { status: r.status, stderr: r.stderr };
}

describe("protege-escrita.sh", () => {
  let root = "";
  let fora = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "protege-escrita-")));
    fora = realpathSync(mkdtempSync(path.join(tmpdir(), "protege-escrita-fora-")));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@t");
    git(root, "config", "user.name", "t");
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "settings.json"), "{}\n");
    mkdirSync(path.join(root, "docs", "reference"), { recursive: true });
    writeFileSync(path.join(root, "docs", "reference", "old.md"), "x\n");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export {};\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // lohra/ = repo git aninhado, sem .claude/settings.json (checkout do Python)
    mkdirSync(path.join(root, "lohra"), { recursive: true });
    git(path.join(root, "lohra"), "init", "-q");
    // worktree de agente dentro do projeto
    mkdirSync(path.join(root, ".claude", "worktrees"), { recursive: true });
    git(root, "worktree", "add", "-q", "--detach", path.join(root, ".claude", "worktrees", "w"));
    // symlink que escapa para docs/reference
    symlinkSync(path.join(root, "docs", "reference"), path.join(root, "atalho"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  });

  it("docs/reference/** a partir da raiz: nega", () => {
    const r = escrever(root, path.join(root, "docs", "reference", "novo.md"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/docs\/reference/u);
  });

  it("caminho relativo a partir de um subdiretório: nega", () => {
    expect(escrever(path.join(root, "src"), "../docs/reference/novo.md").status).toBe(2);
  });

  it("lohra/** com cwd dentro do repo aninhado: nega (raiz é o projeto, que tem settings.json)", () => {
    const r = escrever(path.join(root, "lohra"), path.join(root, "lohra", "x.py"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lohra/u);
  });

  it("src/** : permite", () => {
    expect(escrever(root, path.join(root, "src", "b.ts")).status).toBe(0);
  });

  it("fora de qualquer repo (scratchpad): permite", () => {
    expect(escrever(root, path.join(fora, "nota.md")).status).toBe(0);
  });

  it("symlink dentro do repo que resolve para docs/reference: nega", () => {
    const r = escrever(root, path.join(root, "atalho", "novo.md"));
    expect(r.status).toBe(2);
  });

  it("worktree de agente em .claude/worktrees/w: docs/reference lá dentro é negado, com cwd na raiz do projeto", () => {
    const alvo = path.join(root, ".claude", "worktrees", "w", "docs", "reference", "novo.md");
    const r = escrever(root, alvo);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/docs\/reference/u);
  });

  it("worktree de agente: com cwd no próprio worktree também nega; src/ lá dentro permite", () => {
    const w = path.join(root, ".claude", "worktrees", "w");
    expect(escrever(w, path.join(w, "docs", "reference", "novo.md")).status).toBe(2);
    expect(escrever(w, path.join(w, "src", "c.ts")).status).toBe(0);
  });

  it("ferramenta que não escreve (Read): sai 0", () => {
    expect(escrever(root, path.join(root, "docs", "reference", "old.md"), "Read").status).toBe(0);
  });
});
