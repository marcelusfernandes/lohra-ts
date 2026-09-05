// Issue #48 — controle negativo: `classificar`/`arquivosDeTeste`/
// `semHarnessNaBase`/`ehCommitTestRed`/`parseArgs` (puros, `lib.ts`) e um
// caso de integração de ponta a ponta em repositórios git temporários e
// descartáveis (`run.ts`, via subprocesso — o mesmo padrão de
// `tests/prova-run.test.ts`). O "harness" desses repositórios fake é um
// script Node standalone (`prova-run.cjs`) que nunca toca vitest/tsx: o
// controle negativo trata `npm run -s prova -- <slug>` como caixa-preta,
// então o fake só precisa produzir um `resumo.json` no mesmo formato.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  arquivosDeTeste,
  classificar,
  ehCommitTestRed,
  parseArgs,
  semHarnessNaBase,
} from "../scripts/ci/controle-negativo/lib.js";
import type { Resumo } from "../scripts/prova/tipos.js";

const repoRoot = resolve(import.meta.dirname, "..");
const runScript = resolve(repoRoot, "scripts/ci/controle-negativo/run.ts");
const tsxBin = resolve(repoRoot, "node_modules/.bin/tsx");

describe("classificar", () => {
  it("assertion-red: alguma falha não é estrutural", () => {
    const resumo: Resumo = {
      ok: false,
      total: 1,
      falhas: [{ nome: "soma > deveria somar 1 e 2", motivo: "esperava 3, obteve 5" }],
    };
    expect(classificar(resumo)).toBe("assertion-red");
  });

  it("structural-red: falha 'X did not run'", () => {
    const resumo: Resumo = {
      ok: false,
      total: 0,
      falhas: [
        {
          nome: "tests/x.test.ts did not run",
          motivo: "arquivo declarado não apareceu no relatório do vitest",
        },
      ],
    };
    expect(classificar(resumo)).toBe("structural-red");
  });

  it("structural-red: falha 'X ran zero tests'", () => {
    const resumo: Resumo = {
      ok: false,
      total: 0,
      falhas: [
        {
          nome: "tests/x.test.ts ran zero tests",
          motivo: "todos os testes do arquivo são skip/todo — nenhum rodou de fato",
        },
      ],
    };
    expect(classificar(resumo)).toBe("structural-red");
  });

  it("structural-red: falha de coleta usa o próprio caminho do teste como nome", () => {
    const resumo: Resumo = {
      ok: false,
      total: 0,
      falhas: [
        { nome: "tests/quebrado.test.ts", motivo: "Cannot find module '../src/nao-existe.js'" },
      ],
    };
    expect(classificar(resumo)).toBe("structural-red");
  });

  it("structural-red: npm run typecheck reprovado", () => {
    const resumo: Resumo = {
      ok: false,
      total: 1,
      falhas: [{ nome: "npm run typecheck", motivo: "exit code 1" }],
    };
    expect(classificar(resumo)).toBe("structural-red");
  });

  it("structural-red: processo do vitest falhou (nome 'vitest run')", () => {
    const resumo: Resumo = {
      ok: false,
      total: 0,
      falhas: [{ nome: "vitest run", motivo: "processo falhou (exit code 1)" }],
    };
    expect(classificar(resumo)).toBe("structural-red");
  });

  it("uma falha de asserção real entre falhas estruturais ainda é assertion-red", () => {
    const resumo: Resumo = {
      ok: false,
      total: 2,
      falhas: [
        { nome: "npm run typecheck", motivo: "exit code 1" },
        { nome: "soma > deveria somar 1 e 2", motivo: "esperava 3, obteve 5" },
      ],
    };
    expect(classificar(resumo)).toBe("assertion-red");
  });

  it("empty-red: ok:false sem falhas normalizadas", () => {
    const resumo: Resumo = { ok: false, total: 0, falhas: [] };
    expect(classificar(resumo)).toBe("empty-red");
  });

  it("vacuous-pass: ok:true", () => {
    const resumo: Resumo = { ok: true, total: 1, falhas: [] };
    expect(classificar(resumo)).toBe("vacuous-pass");
  });
});

describe("arquivosDeTeste", () => {
  it("mantém tests/**/*.test.ts", () => {
    expect(arquivosDeTeste(["tests/foo.test.ts", "tests/sub/bar.test.ts"])).toEqual([
      "tests/foo.test.ts",
      "tests/sub/bar.test.ts",
    ]);
  });

  it("mantém prova/**", () => {
    expect(arquivosDeTeste(["prova/controle-negativo.ts"])).toEqual(["prova/controle-negativo.ts"]);
  });

  it("descarta arquivos de produção e docs", () => {
    expect(arquivosDeTeste(["src/foo.ts", "README.md", "package.json"])).toEqual([]);
  });

  it("descarta arquivo fora de tests/ mesmo terminando em .test.ts", () => {
    expect(arquivosDeTeste(["scripts/foo.test.ts"])).toEqual([]);
  });
});

describe("semHarnessNaBase", () => {
  it("true quando não há scripts.prova", () => {
    expect(semHarnessNaBase(JSON.stringify({ name: "x", scripts: { build: "tsc" } }))).toBe(true);
  });

  it("true quando não há scripts nenhum", () => {
    expect(semHarnessNaBase(JSON.stringify({ name: "x" }))).toBe(true);
  });

  it("true quando o texto não é JSON válido (inclusive package.json ausente)", () => {
    expect(semHarnessNaBase("")).toBe(true);
  });

  it("false quando scripts.prova existe", () => {
    expect(
      semHarnessNaBase(JSON.stringify({ scripts: { prova: "tsx scripts/prova/run.ts" } })),
    ).toBe(false);
  });
});

describe("ehCommitTestRed", () => {
  it("true para test(red): ...", () => {
    expect(ehCommitTestRed("test(red): cobre X")).toBe(true);
  });

  it("false para outros tipos de commit", () => {
    expect(ehCommitTestRed("feat: cobre X")).toBe(false);
    expect(ehCommitTestRed("test: cobre X")).toBe(false);
    expect(ehCommitTestRed("teste vermelho: cobre X")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("lê --base --head --slug --root", () => {
    expect(
      parseArgs(["--base", "aaa", "--head", "bbb", "--slug", "foo", "--root", "/tmp/x"]),
    ).toEqual({ base: "aaa", head: "bbb", slug: "foo", root: "/tmp/x" });
  });

  it("omite chaves não passadas", () => {
    expect(parseArgs(["--base", "aaa", "--head", "bbb"])).toEqual({ base: "aaa", head: "bbb" });
  });
});

// --- Integração: repositórios git temporários e descartáveis -------------

const PROVA_RUN_CJS = `
const fs = require("fs");
const path = require("path");
const slug = process.argv[2];
const testPath = path.join(__dirname, "tests", slug + ".test.ts");
let resumo;
try {
  const src = fs.readFileSync(testPath, "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", "require", src)(mod, mod.exports, require);
  mod.exports.run();
  resumo = { ok: true, total: 1, falhas: [] };
} catch (err) {
  const nome =
    err && err.code === "MODULE_NOT_FOUND" ? "tests/" + slug + ".test.ts" : "asserção real";
  resumo = { ok: false, total: 1, falhas: [{ nome, motivo: String((err && err.message) || err) }] };
}
const outDir = path.join(__dirname, ".prova", slug);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "resumo.json"), JSON.stringify(resumo, null, 2) + "\\n");
process.stdout.write(JSON.stringify(resumo) + "\\n");
process.exit(resumo.ok ? 0 : 1);
`;

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
}

function gitCapture(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function novoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
  workdirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "prova@example.com"]);
  git(dir, ["config", "user.name", "Prova"]);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fake", version: "0.0.0", scripts: { prova: "node prova-run.cjs" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "prova-run.cjs"), PROVA_RUN_CJS);
  return dir;
}

function commitTudo(dir: string, mensagem: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", mensagem]);
  return gitCapture(dir, ["rev-parse", "HEAD"]);
}

/** Base com uma implementação errada; HEAD acrescenta o teste (que passa a
 * reprovar de verdade contra o bug da base) — cenário `assertion-red`. */
function repoAssertionRed(): { dir: string; base: string; head: string; slug: string } {
  const dir = novoRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a - b;\n");
  const base = commitTudo(dir, "feat: soma inicial (com bug)");

  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "soma.test.ts"),
    [
      'const { somar } = require("./src/soma.cjs");',
      "module.exports.run = function () {",
      "  const resultado = somar(1, 2);",
      '  if (resultado !== 3) { throw new Error("esperava 3, obteve " + resultado); }',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "prova", "soma.ts"), "// declaração de prova (fixture de teste)\n");
  writeFileSync(join(dir, "src", "soma.cjs"), "module.exports.somar = (a, b) => a + b;\n");
  const head = commitTudo(dir, "test(red): cobre soma com o bug corrigido");
  return { dir, base, head, slug: "soma" };
}

/** Teste sem asserção nenhuma — passa até contra a base sem implementação. */
function repoVacuousPass(): { dir: string; base: string; head: string; slug: string } {
  const dir = novoRepo();
  const base = commitTudo(dir, "chore: repo vazio");

  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(join(dir, "tests", "vazio.test.ts"), "module.exports.run = function () {};\n");
  writeFileSync(join(dir, "prova", "vazio.ts"), "// declaração de prova (fixture de teste)\n");
  const head = commitTudo(dir, "test: teste que não afirma nada");
  return { dir, base, head, slug: "vazio" };
}

/** Teste que exige um módulo que a base não tem de jeito nenhum — falha só
 * estrutural (`MODULE_NOT_FOUND`), aceita ou não conforme o último commit. */
function repoStructuralRed(ultimoCommitEhTestRed: boolean): {
  dir: string;
  base: string;
  head: string;
  slug: string;
} {
  const dir = novoRepo();
  const base = commitTudo(dir, "chore: repo vazio");

  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "estrutural.test.ts"),
    [
      'const { somar } = require("./src/estrutural.cjs");',
      "module.exports.run = function () {",
      '  if (somar(1, 2) !== 3) { throw new Error("nunca chega aqui"); }',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "prova", "estrutural.ts"), "// declaração de prova (fixture de teste)\n");
  let head = commitTudo(dir, "test(red): cobre estrutural (módulo ainda não existe)");

  if (!ultimoCommitEhTestRed) {
    writeFileSync(
      join(dir, "tests", "estrutural.test.ts"),
      [
        'const { somar } = require("./src/estrutural.cjs");',
        "module.exports.run = function () {",
        "  // comentário adicionado depois do vermelho — não é mais o último",
        "  // commit a tocar este arquivo",
        '  if (somar(1, 2) !== 3) { throw new Error("nunca chega aqui"); }',
        "};",
        "",
      ].join("\n"),
    );
    head = commitTudo(dir, "refactor: comentário no teste (não é test(red):)");
  }

  return { dir, base, head, slug: "estrutural" };
}

function runControleNegativo(args: readonly string[]): SpawnSyncReturns<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("VITEST") && key !== "LOHRA_PROVA_OUT",
    ),
  );
  return spawnSync(tsxBin, [runScript, ...args], { encoding: "utf8", timeout: 60_000, env });
}

describe("controle-negativo/run.ts (subprocesso, repositório git descartável)", () => {
  it("assertion-red: exit 0, e o worktree temporário é removido", () => {
    const { dir, base, head, slug } = repoAssertionRed();
    const before = gitCapture(dir, ["worktree", "list", "--porcelain"]);

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      slug,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("assertion-red");
    expect(gitCapture(dir, ["worktree", "list", "--porcelain"])).toBe(before);
  });

  it("vacuous-pass: exit 1, e o worktree temporário é removido mesmo reprovando", () => {
    const { dir, base, head, slug } = repoVacuousPass();
    const before = gitCapture(dir, ["worktree", "list", "--porcelain"]);

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      slug,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("vacuous-pass");
    expect(gitCapture(dir, ["worktree", "list", "--porcelain"])).toBe(before);
  });

  it("structural-red aceito quando o último commit que toca os testes é test(red):", () => {
    const { dir, base, head, slug } = repoStructuralRed(true);

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      slug,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("structural-red");
  });

  it("structural-red reprovado quando o último commit que toca os testes NÃO é test(red):", () => {
    const { dir, base, head, slug } = repoStructuralRed(false);

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      slug,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("estrutural sem test(red)");
  });

  it("exit 1 citando o caminho quando prova/<slug>.ts não existe no HEAD", () => {
    const dir = novoRepo();
    const sha = commitTudo(dir, "chore: init");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      sha,
      "--head",
      sha,
      "--slug",
      "inexistente",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prova/inexistente.ts");
  });

  it("PASS logado quando a base não declara scripts.prova (harness ainda não existia)", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
    workdirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "prova@example.com"]);
    git(dir, ["config", "user.name", "Prova"]);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "sem-harness" })}\n`);
    const base = commitTudo(dir, "chore: repo antes do harness #42");

    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "prova"), { recursive: true });
    writeFileSync(join(dir, "tests", "algo.test.ts"), "module.exports.run = function () {};\n");
    writeFileSync(join(dir, "prova", "algo.ts"), "// fixture\n");
    const head = commitTudo(dir, "test(red): cobre algo");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      "algo",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("sem harness na base");
  });
});
