// Bancada do hook PreToolUse(Edit|Write) `.claude/hooks/protege-escrita.sh` (issue #61).
//
// Monta um repositório temporário com `.claude/settings.json`, `docs/reference/`
// e um `lohra/` que é repo git ANINHADO (como o checkout do Python), mais um
// worktree de agente em `.claude/worktrees/w`. A raiz das regras é o toplevel git
// mais INTERNO, a partir do ALVO, que contenha `.claude/settings.json`: dentro do
// worktree a raiz é o worktree (senão `.claude/worktrees/w/docs/reference/x` não
// casaria), dentro de `lohra/` a raiz é o projeto (lohra/ não tem settings).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProcessShell, spawnProcessShell } from "./helpers/process-shell.js";

const HOOK = fileURLToPath(new URL("../.claude/hooks/protege-escrita.sh", import.meta.url));

function git(cwd: string, ...args: readonly string[]): void {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

interface HookRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly shell: string;
}

function escrever(cwd: string, filePath: string, toolName = "Write"): HookRun {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  const shell = resolveProcessShell(env);
  const r = spawnProcessShell(
    [HOOK],
    {
      input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath }, cwd }),
      encoding: "utf8",
      env,
    },
    shell,
  );
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, shell };
}

function expectDenied(r: HookRun): void {
  const msysFlag = (name: string): "unset" | "wildcard" | "set-other" => {
    const value = process.env[name];
    return value === undefined || value === "" ? "unset" : value === "*" ? "wildcard" : "set-other";
  };
  expect(
    r.status,
    JSON.stringify({
      ...r,
      msysNoPathconv: msysFlag("MSYS_NO_PATHCONV"),
      msysArgConvExcl: msysFlag("MSYS2_ARG_CONV_EXCL"),
      msysEnvConvExcl: msysFlag("MSYS2_ENV_CONV_EXCL"),
    }),
  ).toBe(2);
  const denial = JSON.parse(r.stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(denial.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(denial.hookSpecificOutput.permissionDecisionReason).toMatch(/Bloqueado/u);
  expect(r.stderr).toMatch(/Bloqueado/u);
}

function lerComFalha(cwd: string, reader: "absent" | "failed-partial"): HookRun {
  const resolvedShell = resolveProcessShell();
  // Git/bin/sh.exe injeta /usr/bin no PATH; o executável irmão em usr/bin
  // conserva o PATH controlado pela fixture.
  const directShell = path.resolve(path.dirname(resolvedShell), "..", "usr", "bin", "sh.exe");
  const shell =
    process.platform === "win32" && existsSync(directShell) ? directShell : resolvedShell;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "path") env[key] = value;
  }
  const executableDir = path.dirname(process.execPath);
  if (reader === "failed-partial") {
    const bin = path.join(cwd, "reader-failure-bin");
    mkdirSync(bin, { recursive: true });
    const fakeCat = path.join(bin, "cat");
    writeFileSync(
      fakeCat,
      '#!/bin/sh\nprintf "partial-secret-value"\nprintf "reader-secret-value" >&2\nexit 17\n',
    );
    chmodSync(fakeCat, 0o755);
    env.PATH = [bin, executableDir].join(path.delimiter);
  } else {
    env.PATH = executableDir;
  }
  const readerProbe = spawnSync(shell, ["-c", "command -v cat"], { cwd, env, encoding: "utf8" });
  if (reader === "absent") expect(readerProbe.status).not.toBe(0);
  else expect(readerProbe.status).toBe(0);
  const nodeProbe = spawnSync(shell, ["-c", "command -v node"], { cwd, env, encoding: "utf8" });
  expect(nodeProbe.status).toBe(0);
  const input = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: path.join(cwd, "docs", "reference", "novo.md") },
    cwd,
    token: "payload-secret-value",
  });
  const result = spawnSync(shell, [HOOK], { cwd, env, input, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, shell };
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
    // symlink que foge para FORA de qualquer repositório
    symlinkSync(fora, path.join(root, "fuga"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  });

  it("docs/reference/** a partir da raiz: nega", () => {
    const r = escrever(root, path.join(root, "docs", "reference", "novo.md"));
    expectDenied(r);
    expect(r.stderr).toMatch(/docs\/reference/u);
  });

  it("nega quando o leitor cat está ausente, mesmo com node disponível", () => {
    const result = lerComFalha(root, "absent");
    expectDenied(result);
    expect(result.stdout).toMatch(/falha de leitura do payload/u);
    expect(result.stdout).toMatch(/status 127/u);
    expect(result.stdout + result.stderr).not.toMatch(/payload-secret-value/u);
  });

  it("nega quando cat emite saída parcial e termina com status não-zero", () => {
    const result = lerComFalha(root, "failed-partial");
    expectDenied(result);
    expect(result.stdout).toMatch(/falha de leitura do payload/u);
    expect(result.stdout).toMatch(/status 17/u);
    expect(result.stdout + result.stderr).not.toMatch(
      /partial-secret-value|reader-secret-value|payload-secret-value/u,
    );
  });

  it("caminho relativo a partir de um subdiretório: nega", () => {
    expectDenied(escrever(path.join(root, "src"), "../docs/reference/novo.md"));
  });

  it("lohra/** com cwd dentro do repo aninhado: nega (raiz é o projeto, que tem settings.json)", () => {
    const r = escrever(path.join(root, "lohra"), path.join(root, "lohra", "x.py"));
    expectDenied(r);
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
    expectDenied(r);
  });

  it("symlink dentro do repo que resolve para FORA de qualquer repo: nega (caminho textual está dentro)", () => {
    const r = escrever(root, path.join(root, "fuga", "x.md"));
    expectDenied(r);
    expect(r.stderr).toMatch(/symlink/u);
  });

  it("worktree de agente em .claude/worktrees/w: docs/reference lá dentro é negado, com cwd na raiz do projeto", () => {
    const alvo = path.join(root, ".claude", "worktrees", "w", "docs", "reference", "novo.md");
    const r = escrever(root, alvo);
    expectDenied(r);
    expect(r.stderr).toMatch(/docs\/reference/u);
  });

  it("worktree de agente: com cwd no próprio worktree também nega; src/ lá dentro permite", () => {
    const w = path.join(root, ".claude", "worktrees", "w");
    expectDenied(escrever(w, path.join(w, "docs", "reference", "novo.md")));
    expect(escrever(w, path.join(w, "src", "c.ts")).status).toBe(0);
  });

  it("ferramenta que não escreve (Read): sai 0", () => {
    expect(escrever(root, path.join(root, "docs", "reference", "old.md"), "Read").status).toBe(0);
  });

  it("diagnostica Git e caminho canônico no mesmo transporte do hook", () => {
    const probe = path.join(root, "write-hook-root-probe.sh");
    writeFileSync(
      probe,
      [
        "#!/bin/sh",
        "payload=$(cat)",
        'PE_PAYLOAD="$payload" node -e \'',
        'const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");',
        'const j=JSON.parse(process.env.PE_PAYLOAD||"");',
        "const dir=fs.realpathSync(path.dirname(j.tool_input.file_path));",
        'const g=spawnSync("git",["rev-parse","--show-toplevel"],{cwd:dir,encoding:"utf8"});',
        "const top=g.status===0?fs.realpathSync(g.stdout.trim()):null;",
        'const rel=top?path.relative(top,path.join(dir,path.basename(j.tool_input.file_path))).split(path.sep).join("/"):null;',
        "const nativeDir=fs.realpathSync.native(path.dirname(j.tool_input.file_path));",
        "const nativeTop=g.status===0?fs.realpathSync.native(g.stdout.trim()):null;",
        'const nativeRel=nativeTop?path.relative(nativeTop,path.join(nativeDir,path.basename(j.tool_input.file_path))).split(path.sep).join("/"):null;',
        'process.stdout.write(JSON.stringify({tool:j.tool_name,gitStatus:g.status,gitError:g.error?.code??null,settings:top?fs.existsSync(path.join(top,".claude","settings.json")):false,relative:rel,nativeRelative:nativeRel}));',
        "'",
        "",
      ].join("\n"),
    );
    const input = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "docs", "reference", "novo.md") },
      cwd: root,
    });
    const result = spawnProcessShell([probe], { input, encoding: "utf8" });
    expect(result.status, JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).toBe(0);
    const actual = JSON.parse(result.stdout) as {
      tool: string;
      gitStatus: number;
      gitError: string | null;
      settings: boolean;
      relative: string;
      nativeRelative: string;
    };
    expect(actual.nativeRelative, JSON.stringify(actual)).toBe("docs/reference/novo.md");
    expect(actual).toMatchObject({
      tool: "Write",
      gitStatus: 0,
      gitError: null,
      settings: true,
      nativeRelative: "docs/reference/novo.md",
    });
  });
});
