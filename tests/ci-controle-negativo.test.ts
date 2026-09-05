// Issue #48 — controle negativo: `classificar`/`arquivosDeTeste`/
// `semHarnessNaBase`/`ehCommitTestRed`/`contemStubQueLanca`/
// `deveSerIgnorado`/`validarResumo`/`parseArgs` (puros, `lib.ts`), `overlay`
// (unitário, com `mostrarArquivo` injetado — sem git de verdade), e um caso
// de integração de ponta a ponta em repositórios git temporários e
// descartáveis (`run.ts`, via subprocesso — o mesmo padrão de
// `tests/prova-run.test.ts`). O "harness" desses repositórios fake é um
// script Node standalone (`prova-run.cjs`) que nunca toca vitest/tsx: o
// controle negativo trata `npm run -s prova -- <slug>` como caixa-preta,
// então o fake só precisa produzir um `resumo.json` no mesmo formato.
//
// Rodada 2 da PR #54: a regra de `structural-red` mudou de "o ÚLTIMO
// commit que toca os testes precisa ser test(red):" (reprovava toda PR TDD
// normal) para "existe PELO MENOS UM test(red): que toca os testes E
// adiciona um stub que lança num arquivo não-teste do diff".
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  arquivosDeTeste,
  classificar,
  contemStubQueLanca,
  deveSerIgnorado,
  ehArquivoDocsOuProcess,
  ehCommitTestRed,
  parseArgs,
  semHarnessNaBase,
  validarResumo,
} from "../scripts/ci/controle-negativo/lib.js";
import { overlay } from "../scripts/ci/controle-negativo/run.js";
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

  it("false quando scripts.prova existe", () => {
    expect(
      semHarnessNaBase(JSON.stringify({ scripts: { prova: "tsx scripts/prova/run.ts" } })),
    ).toBe(false);
  });

  it("lança quando o texto não é JSON válido — package.json ILEGÍVEL é falha, não 'sem harness'", () => {
    expect(() => semHarnessNaBase("{ isso não é json")).toThrow();
    expect(() => semHarnessNaBase("")).toThrow();
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

describe("contemStubQueLanca", () => {
  it("true quando há uma linha ADICIONADA com throw new Error(", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "+++ b/src/x.ts",
      "+export function x() {",
      '+  throw new Error("not implemented");',
      "+}",
      "",
    ].join("\n");
    expect(contemStubQueLanca(diff)).toBe(true);
  });

  it("false quando as linhas adicionadas não lançam", () => {
    const diff = ["+++ b/src/x.ts", "+export function x() {", "+  return 1;", "+}", ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ignora o cabeçalho +++ do diff (não é uma linha adicionada de verdade)", () => {
    const diff = "+++ b/throw new Error(arquivo).ts\n";
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ignora linhas removidas (-) com throw new Error(", () => {
    const diff = '-  throw new Error("velho");\n';
    expect(contemStubQueLanca(diff)).toBe(false);
  });
});

describe("ehArquivoDocsOuProcess / deveSerIgnorado", () => {
  it("classifica docs/**", () => {
    expect(ehArquivoDocsOuProcess("docs/adr/0005.md")).toBe(true);
  });

  it("classifica README.md, CLAUDE.md, AGENTS.md no topo", () => {
    expect(ehArquivoDocsOuProcess("README.md")).toBe(true);
    expect(ehArquivoDocsOuProcess("CLAUDE.md")).toBe(true);
    expect(ehArquivoDocsOuProcess("AGENTS.md")).toBe(true);
  });

  it("classifica .claude/** e .github/**", () => {
    expect(ehArquivoDocsOuProcess(".claude/skills/pr/SKILL.md")).toBe(true);
    expect(ehArquivoDocsOuProcess(".github/workflows/ci.yml")).toBe(true);
  });

  it("não classifica código de produção", () => {
    expect(ehArquivoDocsOuProcess("scripts/ci/controle-negativo/lib.ts")).toBe(false);
  });

  it("SKIP quando todo o diff cai nas classes docs/process", () => {
    expect(deveSerIgnorado(["docs/a.md", "README.md", ".github/workflows/ci.yml"])).toBe(true);
  });

  it("não faz SKIP quando há qualquer arquivo fora dessas classes", () => {
    expect(deveSerIgnorado(["docs/a.md", "src/x.ts"])).toBe(false);
  });

  it("não faz SKIP para diff vazio (não é 'classe docs/process', é 'nada mudou')", () => {
    expect(deveSerIgnorado([])).toBe(false);
  });
});

describe("validarResumo", () => {
  it("aceita um Resumo bem formado", () => {
    const resumo = { ok: true, total: 2, falhas: [] };
    expect(validarResumo(resumo, ".prova/x/resumo.json")).toEqual(resumo);
  });

  it("lança citando o caminho quando 'ok' não é boolean", () => {
    expect(() => validarResumo({ total: 1, falhas: [] }, ".prova/x/resumo.json")).toThrow(
      /\.prova\/x\/resumo\.json/,
    );
  });

  it("lança quando 'falhas' não é array de {nome,motivo}", () => {
    expect(() =>
      validarResumo({ ok: false, total: 1, falhas: [{ nome: "a" }] }, "r.json"),
    ).toThrow();
  });

  it("lança quando o valor nem é um objeto", () => {
    expect(() => validarResumo(null, "r.json")).toThrow();
    expect(() => validarResumo("string", "r.json")).toThrow();
  });

  it("default total:0 quando ausente", () => {
    expect(validarResumo({ ok: true, falhas: [] }, "r.json")).toEqual({
      ok: true,
      total: 0,
      falhas: [],
    });
  });
});

describe("parseArgs", () => {
  it("lê --base --head --slug --branch --root", () => {
    expect(
      parseArgs([
        "--base",
        "aaa",
        "--head",
        "bbb",
        "--slug",
        "foo",
        "--branch",
        "feat/1-foo",
        "--root",
        "/tmp/x",
      ]),
    ).toEqual({ base: "aaa", head: "bbb", slug: "foo", branch: "feat/1-foo", root: "/tmp/x" });
  });

  it("omite chaves não passadas", () => {
    expect(parseArgs(["--base", "aaa", "--head", "bbb"])).toEqual({ base: "aaa", head: "bbb" });
  });
});

describe("overlay (unitário, sem git de verdade — mostrarArquivo injetado)", () => {
  const overlayDirs: string[] = [];
  afterEach(() => {
    while (overlayDirs.length > 0) {
      const dir = overlayDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status D remove o arquivo do worktree sem chamar mostrarArquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-overlay-"));
    overlayDirs.push(dir);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "velho.test.ts"), "obsoleto\n");

    overlay(dir, "cafe", [{ status: "D", arquivo: "tests/velho.test.ts" }], () => {
      throw new Error("não deveria ser chamado para status D");
    });

    expect(existsSync(join(dir, "tests", "velho.test.ts"))).toBe(false);
  });

  it("A/M escreve o conteúdo devolvido por mostrarArquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-overlay-"));
    overlayDirs.push(dir);

    overlay(dir, "cafe", [{ status: "A", arquivo: "tests/novo.test.ts" }], () => ({
      status: 0,
      stdout: Buffer.from("module.exports.run = function () {};\n"),
      stderr: Buffer.alloc(0),
    }));

    expect(existsSync(join(dir, "tests", "novo.test.ts"))).toBe(true);
  });

  it("lança quando mostrarArquivo (git show) falha para um A/M do diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-overlay-"));
    overlayDirs.push(dir);

    expect(() => {
      overlay(dir, "cafe", [{ status: "M", arquivo: "tests/x.test.ts" }], () => ({
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fatal: bad object cafe:tests/x.test.ts"),
      }));
    }).toThrow(/fatal: bad object/);
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

const TESTE_ESTRUTURAL = [
  'const { somar } = require("./src/estrutural.cjs");',
  "module.exports.run = function () {",
  '  if (somar(1, 2) !== 3) { throw new Error("nunca chega aqui"); }',
  "};",
  "",
].join("\n");

/**
 * Base sem `src/estrutural.cjs` — o `require` no teste falha com
 * `MODULE_NOT_FOUND` (estrutural). As quatro variantes cobrem a regra nova
 * de `structural-red` (rodada 2 da PR #54):
 *   - "com-stub": um único commit `test(red):` que adiciona o teste E um
 *     stub que lança em `src/estrutural.cjs` (arquivo NÃO-teste) — aceito.
 *   - "com-fix-depois": o mesmo `test(red):` com stub, seguido de um
 *     commit comum que só toca o teste de novo — ainda aceito (o gate é
 *     "existe pelo menos um", não "o último").
 *   - "sem-test-red": nenhum commit no range é `test(red):` — reprovado.
 *   - "sem-stub": o commit É `test(red):`, mas não toca nenhum arquivo
 *     não-teste (sem stub declarado) — reprovado.
 */
function repoStructuralRed(variante: "com-stub" | "com-fix-depois" | "sem-test-red" | "sem-stub"): {
  dir: string;
  base: string;
  head: string;
  slug: string;
} {
  const dir = novoRepo();
  const base = commitTudo(dir, "chore: repo vazio");

  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "prova"), { recursive: true });
  writeFileSync(join(dir, "tests", "estrutural.test.ts"), TESTE_ESTRUTURAL);
  writeFileSync(join(dir, "prova", "estrutural.ts"), "// declaração de prova (fixture de teste)\n");

  if (variante === "sem-test-red") {
    const head = commitTudo(dir, "feat: cobre estrutural (sem test(red):)");
    return { dir, base, head, slug: "estrutural" };
  }

  if (variante === "sem-stub") {
    // test(red) real, mas sem tocar nenhum arquivo não-teste — nenhum stub
    // declarado (worktree-segura §7 pede o stub NO MESMO commit).
    const head = commitTudo(dir, "test(red): cobre estrutural (sem stub de produção)");
    return { dir, base, head, slug: "estrutural" };
  }

  // "com-stub" / "com-fix-depois": adiciona o stub que lança num arquivo
  // não-teste, no MESMO commit `test(red):`.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "estrutural.cjs"),
    'module.exports.somar = () => { throw new Error("not implemented: somar"); };\n',
  );
  let head = commitTudo(dir, "test(red): cobre estrutural (stub que lança)");

  if (variante === "com-fix-depois") {
    writeFileSync(
      join(dir, "tests", "estrutural.test.ts"),
      `${TESTE_ESTRUTURAL}// comentário adicionado depois do vermelho\n`,
    );
    head = commitTudo(dir, "fix(ci): comentário no teste (não é test(red):)");
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

  it("structural-red aceito: um único commit test(red): com stub que lança", () => {
    const { dir, base, head, slug } = repoStructuralRed("com-stub");

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

  it("structural-red aceito: test(red): com stub seguido de um commit de fix comum", () => {
    const { dir, base, head, slug } = repoStructuralRed("com-fix-depois");

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

  it("structural-red reprovado: nenhum commit test(red): no range", () => {
    const { dir, base, head, slug } = repoStructuralRed("sem-test-red");

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
    expect(result.stderr).toContain("estrutural sem test(red) válido");
  });

  it("structural-red reprovado: test(red): existe mas não adiciona stub que lança", () => {
    const { dir, base, head, slug } = repoStructuralRed("sem-stub");

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
    expect(result.stderr).toContain("estrutural sem test(red) válido");
  });

  it("SKIP quando todo o diff é classe docs/process, mesmo sem prova/<slug>.ts", () => {
    const dir = novoRepo();
    const base = commitTudo(dir, "chore: init");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "nota.md"), "# nota\n");
    const head = commitTudo(dir, "docs: adiciona nota");

    const result = runControleNegativo(["--root", dir, "--base", base, "--head", head]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP");
  });

  it("exit 1 citando o caminho quando prova/<slug>.ts não existe no HEAD (fora do SKIP)", () => {
    const dir = novoRepo();
    const base = commitTudo(dir, "chore: init");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "algo.cjs"), "module.exports.algo = () => 1;\n");
    const head = commitTudo(dir, "feat: adiciona algo (sem prova)");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      "inexistente",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prova/inexistente.ts");
  });

  it("--branch resolve o slug quando o HEAD está detached (checkout de CI)", () => {
    const { dir, base, head, slug } = repoAssertionRed();
    // Simula o checkout do CI: HEAD detached, sem branch local para `git
    // branch --show-current` resolver.
    git(dir, ["checkout", "--detach", head]);

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--branch",
      `feat/999-${slug}`,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("assertion-red");
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

  it("exit 1 quando o package.json da base é JSON inválido (ilegível, não 'sem harness')", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
    workdirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "prova@example.com"]);
    git(dir, ["config", "user.name", "Prova"]);
    writeFileSync(join(dir, "package.json"), "{ isso não é json");
    const base = commitTudo(dir, "chore: package.json corrompido");

    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "prova"), { recursive: true });
    writeFileSync(join(dir, "tests", "z.test.ts"), "module.exports.run = function () {};\n");
    writeFileSync(join(dir, "prova", "z.ts"), "// fixture\n");
    const head = commitTudo(dir, "test(red): cobre z");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      "z",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package.json");
    expect(result.stderr).not.toContain("sem harness");
  });

  it("exit 1 citando o caminho quando resumo.json da base tem shape inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
    workdirs.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "prova@example.com"]);
    git(dir, ["config", "user.name", "Prova"]);
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ scripts: { prova: "node prova-run.cjs" } })}\n`,
    );
    writeFileSync(
      join(dir, "prova-run.cjs"),
      [
        'const fs = require("fs");',
        'const path = require("path");',
        "const slug = process.argv[2];",
        'const outDir = path.join(__dirname, ".prova", slug);',
        "fs.mkdirSync(outDir, { recursive: true });",
        'fs.writeFileSync(path.join(outDir, "resumo.json"), JSON.stringify({ total: 1 }) + "\\n");',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const base = commitTudo(dir, "chore: harness com resumo.json quebrado (sem 'ok')");

    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "prova"), { recursive: true });
    writeFileSync(join(dir, "tests", "x.test.ts"), "module.exports.run = function () {};\n");
    writeFileSync(join(dir, "prova", "x.ts"), "// fixture\n");
    const head = commitTudo(dir, "test(red): cobre x");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      "x",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".prova/x/resumo.json");
    expect(result.stderr).toContain('"ok"');
  });

  it("cita a causa do npm run prova quando a base não produz resumo.json", () => {
    const dir = novoRepo();
    // Sobrescreve o harness fake para nunca escrever resumo.json.
    writeFileSync(join(dir, "prova-run.cjs"), "process.exit(7);\n");
    const base = commitTudo(dir, "chore: harness quebrado (nunca escreve resumo.json)");

    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "prova"), { recursive: true });
    writeFileSync(join(dir, "tests", "y.test.ts"), "module.exports.run = function () {};\n");
    writeFileSync(join(dir, "prova", "y.ts"), "// fixture\n");
    const head = commitTudo(dir, "test(red): cobre y");

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--slug",
      "y",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("resumo.json");
    expect(result.stderr).toContain("exit code 7");
  });

  it("exit 1 e sem diretório temporário vazando quando git worktree add falha (base inexistente)", () => {
    const { dir, head, slug } = repoAssertionRed();
    const baseInvalida = "0".repeat(40);
    const antes = readdirSync(tmpdir()).filter((nome) => nome.startsWith("controle-negativo-"));

    const result = runControleNegativo([
      "--root",
      dir,
      "--base",
      baseInvalida,
      "--head",
      head,
      "--slug",
      slug,
    ]);

    expect(result.status).toBe(1);
    const depois = readdirSync(tmpdir()).filter((nome) => nome.startsWith("controle-negativo-"));
    expect(depois).toEqual(antes);
  });
});
