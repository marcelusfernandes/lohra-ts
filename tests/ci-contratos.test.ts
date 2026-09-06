// Issue #50: as três regras de `scripts/ci/contratos/lib.ts` e o subprocesso
// `run.ts` (modo dry-run). Cada regra tem caso positivo e negativo; a
// auto-exclusão é provada duas vezes — uma unitária (import-proibido não
// dispara sob `scripts/ci/**`/`tests/ci-*.test.ts` mesmo com o `avalia`
// chamado direto) e uma em subprocesso, escaneando o repo real com este
// próprio arquivo de teste na lista (ele contém a string "python-repr" nos
// comentários e fixtures abaixo — não pode disparar).
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { regras, rodarContratos, type Regra } from "../scripts/ci/contratos/lib.js";

const root = resolve(import.meta.dirname, "..");
const runScript = resolve(root, "scripts/ci/contratos/run.ts");
const tsxBin = resolve(root, "node_modules/.bin/tsx");
const tsxCliMjs = resolve(root, "node_modules/tsx/dist/cli.mjs");

function gitCli(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

function gitCapture(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}

function novoRepoGit(dir: string): void {
  gitCli(dir, ["init", "-q", "-b", "main"]);
  gitCli(dir, ["config", "user.email", "prova@example.com"]);
  gitCli(dir, ["config", "user.name", "Prova"]);
}

function commitTudo(dir: string, mensagem: string): string {
  gitCli(dir, ["add", "-A"]);
  gitCli(dir, ["commit", "-q", "--allow-empty", "-m", mensagem]);
  return gitCapture(dir, ["rev-parse", "HEAD"]);
}

/** Roda `run.ts` num subprocesso com `PATH` vazio — `git` vira ENOENT.
 * `process.execPath` + o CLI do `tsx` direto (issue #62, mesmo padrão de
 * `tests/ci-escopo.test.ts`). */
function rodarComPathVazio(
  args: readonly string[],
  extraEnv: Record<string, string>,
): SpawnSyncReturns<string> {
  const dirVazio = mkdtempSync(join(tmpdir(), "lohra-contratos-path-vazio-"));
  try {
    return spawnSync(process.execPath, [tsxCliMjs, runScript, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...extraEnv, PATH: dirVazio },
    });
  } finally {
    rmSync(dirVazio, { recursive: true, force: true });
  }
}

function regra(id: string): Regra {
  const encontrada = regras.find((r) => r.id === id);
  if (encontrada === undefined) throw new Error(`regra não encontrada: ${id}`);
  return encontrada;
}

describe("regra caminho-proibido", () => {
  it("dispara para um arquivo sob docs/reference/", () => {
    const violacao = regra("caminho-proibido").avalia("docs/reference/x.md", "conteúdo");
    expect(violacao?.id).toBe("caminho-proibido");
  });

  it("dispara para um arquivo sob lohra/, mesmo removido (conteúdo null)", () => {
    const violacao = regra("caminho-proibido").avalia("lohra/desktop/src/main.ts", null);
    expect(violacao?.id).toBe("caminho-proibido");
  });

  it("não dispara para um arquivo fora dos dois prefixos", () => {
    const violacao = regra("caminho-proibido").avalia("docs/adr/0003-native-wire-format.md", "x");
    expect(violacao).toBeNull();
  });

  it("não dispara por coincidência de substring (docs/reference-antigo/)", () => {
    const violacao = regra("caminho-proibido").avalia("docs/reference-antigo/x.md", "x");
    expect(violacao).toBeNull();
  });
});

describe("regra import-proibido", () => {
  it("dispara para um import de python-json em src/**", () => {
    const conteudo = 'import { pythonJsonDumps } from "./serialization/python-json.js";\n';
    const violacao = regra("import-proibido").avalia("src/qualquer.ts", conteudo);
    expect(violacao?.id).toBe("import-proibido");
  });

  it("dispara para um require de python-repr em scripts/** (fora de scripts/ci/**)", () => {
    const conteudo = 'const { pythonRepr } = require("../src/serialization/python-repr");\n';
    const violacao = regra("import-proibido").avalia("scripts/parity/algo.ts", conteudo);
    expect(violacao?.id).toBe("import-proibido");
  });

  it("não dispara sem import (menção em comentário/texto solto não é import)", () => {
    const conteudo = "// veja python-repr.ts para o formato antigo\n";
    const violacao = regra("import-proibido").avalia("src/qualquer.ts", conteudo);
    expect(violacao).toBeNull();
  });

  it("não dispara em scripts/ci/** (auto-exclusão)", () => {
    const conteudo = 'import { x } from "./python-repr.js";\n';
    const violacao = regra("import-proibido").avalia("scripts/ci/contratos/lib.ts", conteudo);
    expect(violacao).toBeNull();
  });

  it("não dispara em tests/ci-*.test.ts (auto-exclusão)", () => {
    // A string "python-repr" literal, dentro de um import de fixture, não
    // pode acionar a regra quando o ARQUIVO em si é um teste de CI — é
    // exatamente o padrão que este arquivo de teste usa acima.
    const conteudo = 'import { x } from "./python-repr.js";\n';
    const violacao = regra("import-proibido").avalia("tests/ci-contratos.test.ts", conteudo);
    expect(violacao).toBeNull();
  });

  it("não dispara fora de src/**, scripts/** e tests/**", () => {
    const conteudo = 'import { x } from "./python-repr.js";\n';
    const violacao = regra("import-proibido").avalia("docs/adr/0003.md", conteudo);
    expect(violacao).toBeNull();
  });

  it("não dispara quando o conteúdo é null (arquivo removido)", () => {
    const violacao = regra("import-proibido").avalia("src/qualquer.ts", null);
    expect(violacao).toBeNull();
  });
});

describe("regra arquivo-grande", () => {
  function linhas(n: number): string {
    return "x\n".repeat(n);
  }

  it("dispara para um .ts com 801 linhas", () => {
    const violacao = regra("arquivo-grande").avalia("src/gigante.ts", linhas(801));
    expect(violacao?.id).toBe("arquivo-grande");
  });

  it("não dispara para um .ts com exatamente 800 linhas", () => {
    const violacao = regra("arquivo-grande").avalia("src/no-limite.ts", linhas(800));
    expect(violacao).toBeNull();
  });

  it("não dispara para extensão fora da lista (.json)", () => {
    const violacao = regra("arquivo-grande").avalia("src/dados.json", linhas(900));
    expect(violacao).toBeNull();
  });

  it("não dispara para fixtures em tests/fixtures/**", () => {
    const violacao = regra("arquivo-grande").avalia("tests/fixtures/grande.md", linhas(900));
    expect(violacao).toBeNull();
  });

  it("não dispara para docs/reference/** (já coberto por caminho-proibido)", () => {
    const violacao = regra("arquivo-grande").avalia("docs/reference/grande.md", linhas(900));
    expect(violacao).toBeNull();
  });

  it("não dispara quando o conteúdo é null (arquivo removido)", () => {
    const violacao = regra("arquivo-grande").avalia("src/gigante.ts", null);
    expect(violacao).toBeNull();
  });
});

describe("rodarContratos", () => {
  it("agrega violações de vários arquivos e regras, ignorando arquivos limpos", () => {
    const files = ["docs/reference/x.md", "src/limpo.ts", "src/gigante.ts"];
    const lerConteudo = (arquivo: string): string | null => {
      if (arquivo === "src/gigante.ts") return linhasHelper(801);
      if (arquivo === "src/limpo.ts") return "export const x = 1;\n";
      return "conteúdo";
    };
    const violacoes = rodarContratos(files, lerConteudo);
    const ids = violacoes.map((v) => `${v.id}:${v.arquivo}`).sort();
    expect(ids).toEqual(["arquivo-grande:src/gigante.ts", "caminho-proibido:docs/reference/x.md"]);
  });

  function linhasHelper(n: number): string {
    return "x\n".repeat(n);
  }

  it("retorna lista vazia quando nada viola", () => {
    const violacoes = rodarContratos(["src/ok.ts"], () => "export const x = 1;\n");
    expect(violacoes).toEqual([]);
  });
});

describe("run.ts (dry-run, subprocesso)", () => {
  const workdirs: string[] = [];

  afterEach(() => {
    while (workdirs.length > 0) {
      const dir = workdirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkdir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lohra-contratos-"));
    workdirs.push(dir);
    return dir;
  }

  function runDryRun(
    root_: string,
    filesFile: string,
    extraArgs: string[] = [],
  ): SpawnSyncReturns<string> {
    return spawnSync(
      tsxBin,
      [runScript, "--files-file", filesFile, "--root", root_, ...extraArgs],
      { encoding: "utf8", timeout: 30_000 },
    );
  }

  it("exit 1 e lista `id: arquivo` quando o diff viola um contrato", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "x.md"), "não editar\n");
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "docs/reference/x.md\n");

    const result = runDryRun(dir, filesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("caminho-proibido: docs/reference/x.md");
  });

  it("exit 0 quando o diff não viola nada", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "ok.ts"), "export const x = 1;\n");
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "src/ok.ts\n");

    const result = runDryRun(dir, filesFile);

    expect(result.status, result.stderr).toBe(0);
  });

  it("auto-exclusão em subprocesso: escanear o repo real com este próprio arquivo de teste não dispara import-proibido", () => {
    const filesFile = join(mkdtempSync(join(tmpdir(), "lohra-contratos-")), "files.txt");
    workdirs.push(resolve(filesFile, ".."));
    writeFileSync(filesFile, "tests/ci-contratos.test.ts\nscripts/ci/contratos/lib.ts\n");

    const result = runDryRun(root, filesFile, ["--apos-17"]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("import-proibido desligada por default quando o marcador (python-json.ts/python-repr.ts) existe no root", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, "src", "serialization"), { recursive: true });
    writeFileSync(join(dir, "src", "serialization", "python-json.ts"), "export {};\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "usa.ts"),
      'import { pythonJsonDumps } from "./serialization/python-json.js";\n',
    );
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "src/usa.ts\n");

    const semFlag = runDryRun(dir, filesFile);
    expect(semFlag.status, semFlag.stderr).toBe(0);

    const comFlag = runDryRun(dir, filesFile, ["--apos-17"]);
    expect(comFlag.status).toBe(1);
    expect(comFlag.stderr).toContain("import-proibido: src/usa.ts");
  });

  it("import-proibido ligada por default quando o marcador não existe no root", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "usa.ts"),
      'import { pythonJsonDumps } from "./serialization/python-json.js";\n',
    );
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "src/usa.ts\n");

    const result = runDryRun(dir, filesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("import-proibido: src/usa.ts");
  });

  it("flag desconhecida: exit 2 com mensagem de uso (issue #62)", () => {
    const dir = makeWorkdir();
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "");

    const result = runDryRun(dir, filesFile, ["--flag-que-nao-existe"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("uso");
  });

  it("GITHUB_EVENT_PATH com JSON inválido: exit 2 com a causa, nunca stack trace (issue #62)", () => {
    const dir = makeWorkdir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, "{ isso não é json");

    const result = spawnSync(tsxBin, [runScript], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: dir,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("contratos:");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("GITHUB_STEP_SUMMARY inválido: exit 2 com a causa, violações ainda vão pro stderr (issue #62)", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "x.md"), "não editar\n");
    const filesFile = join(dir, "files.txt");
    writeFileSync(filesFile, "docs/reference/x.md\n");

    const result = spawnSync(tsxBin, [runScript, "--files-file", filesFile, "--root", dir], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "nao", "existe", "summary.md") },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("caminho-proibido: docs/reference/x.md");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("git ausente (PATH vazio): exit 2 (infra), mensagem com ENOENT (issue #62)", () => {
    const dir = makeWorkdir();
    novoRepoGit(dir);
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitTudo(dir, "chore: init");
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: "aaa" }, head: { sha: "bbb" } } }),
    );

    const result = rodarComPathVazio([], { GITHUB_EVENT_PATH: eventPath });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ENOENT");
  });

  it("café.md sob docs/reference/ num diff real (git): exit 1, nome completo no stderr (issue #62)", () => {
    const dir = makeWorkdir();
    novoRepoGit(dir);
    const base = commitTudo(dir, "chore: base vazia");
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(join(dir, "docs", "reference", "café.md"), "não editar\n");
    const head = commitTudo(dir, "docs: adiciona café.md");
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
    );

    const result = spawnSync(tsxBin, [runScript], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: dir,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    });

    expect(result.status).toBe(1);
    expect(result.stderr.normalize("NFC")).toContain(
      "caminho-proibido: docs/reference/café.md".normalize("NFC"),
    );
  }, 30_000);
});
