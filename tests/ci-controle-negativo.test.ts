// Issue #48 — controle negativo: `classificar`/`arquivosDeTeste`/
// `semHarnessNaBase`/`ehCommitTestRed`/`contemStubQueLanca`/
// `deveSerIgnorado`/`validarResumo`/`parseArgs` (puros, `lib.ts`), e as
// funções unitárias de `run.ts` que recebem a execução do `git` injetada
// (`overlay`, `commitsQueTocamTestes`, `commitAdicionaStub`) — sem git de
// verdade. O caso de integração de ponta a ponta, em repositórios git
// temporários e descartáveis, está em
// `tests/ci-controle-negativo-integracao.test.ts` (issue #62, divisão do
// arquivo de 862 linhas — AC "arquivos < 800 linhas").
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  arquivosDeTeste,
  classificar,
  contemStubQueLanca,
  deveSerIgnorado,
  ehArquivoDocsOuProcess,
  ehCommitTestRed,
  ehDeclaracaoDeProva,
  parseArgs,
  semHarnessNaBase,
  soDeclaracaoDeProvaExistenteEditada,
  validarResumo,
} from "../scripts/ci/controle-negativo/lib.js";
import {
  commitAdicionaStub,
  commitsQueTocamTestes,
  overlay,
  TIMEOUT_PROVA_MS,
} from "../scripts/ci/controle-negativo/run.js";
import type { Resumo } from "../scripts/prova/tipos.js";

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

  it("ignora linha adicionada que é comentário de linha (// throw new Error() — issue #62)", () => {
    const diff = ["+++ b/src/x.ts", '+  // throw new Error("not implemented");', ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ignora continuação de comentário de bloco (* throw new Error() — issue #62)", () => {
    const diff = [
      "+++ b/src/x.ts",
      "+/**",
      '+ * throw new Error("not implemented") — exemplo no comentário',
      "+ */",
      "",
    ].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ainda reconhece o stub real quando misturado com uma linha de comentário (issue #62)", () => {
    const diff = [
      "+++ b/src/x.ts",
      '+// throw new Error("isto é só um comentário")',
      "+export function x() {",
      '+  throw new Error("not implemented: x");',
      "+}",
      "",
    ].join("\n");
    expect(contemStubQueLanca(diff)).toBe(true);
  });

  // Issue #78: a checagem anterior só excluía linhas que COMEÇAVAM com
  // `//`/`*` — um comentário de bloco de uma linha só, ou um comentário de
  // linha que não está no início, passava como stub real (fail-open).
  it("ignora comentário de bloco de documentação numa linha só (/** throw new Error( */ — issue #78)", () => {
    const diff = ["+++ b/src/x.ts", "+/** throw new Error( */", ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ignora comentário de bloco simples numa linha só (/* throw new Error( */ — issue #78)", () => {
    const diff = ["+++ b/src/x.ts", "+/* throw new Error( */", ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it("ignora comentário de linha que não está no início da linha (x(); // throw new Error( — issue #78)", () => {
    const diff = ["+++ b/src/x.ts", "+x(); // throw new Error(", ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(false);
  });

  it('ainda aceita o stub real, único caso aceito (throw new Error("not implemented") — issue #78)', () => {
    const diff = ["+++ b/src/x.ts", '+  throw new Error("not implemented");', ""].join("\n");
    expect(contemStubQueLanca(diff)).toBe(true);
  });

  it("ignora continuação de comentário de bloco cujo abridor é linha de contexto, não adicionada (issue #78)", () => {
    // `/**` e `*/` são linhas de CONTEXTO (sem `+`) — só a linha do meio foi
    // adicionada. `linhasAdicionadas` nunca vê o abridor/fechador do bloco,
    // então a remoção de comentário de bloco (que precisa ver `/*`...`*/`
    // dentro do próprio texto extraído) não pega esse caso — só a exclusão
    // de linha que começa com `*` (herdada da issue #62) pega.
    const diff = [
      "+++ b/src/x.ts",
      " /**",
      '+ * throw new Error("not implemented") — exemplo',
      "  */",
      "",
    ].join("\n");
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

  it("classifica scripts/github/** e .worktreeinclude — tooling de processo (acréscimo #62)", () => {
    expect(ehArquivoDocsOuProcess("scripts/github/ruleset.sh")).toBe(true);
    expect(ehArquivoDocsOuProcess("scripts/github/labels.sh")).toBe(true);
    expect(ehArquivoDocsOuProcess(".worktreeinclude")).toBe(true);
  });

  it("não classifica scripts/** fora de scripts/github/ — continua exigindo controle", () => {
    expect(ehArquivoDocsOuProcess("scripts/ci/controle-negativo/lib.ts")).toBe(false);
    expect(ehArquivoDocsOuProcess("scripts/prova/run.ts")).toBe(false);
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

describe("ehDeclaracaoDeProva / soDeclaracaoDeProvaExistenteEditada (acréscimo à #62, bloqueia #65)", () => {
  it("ehDeclaracaoDeProva: true só para prova/<slug>.ts (um segmento)", () => {
    expect(ehDeclaracaoDeProva("prova/ruleset-seis-checks.ts")).toBe(true);
    expect(ehDeclaracaoDeProva("prova/sub/x.ts")).toBe(false);
    expect(ehDeclaracaoDeProva("tests/prova-run.test.ts")).toBe(false);
    expect(ehDeclaracaoDeProva("scripts/prova/run.ts")).toBe(false);
  });

  it("SKIP quando o único arquivo fora de docs/process é uma declaração de prova JÁ EXISTENTE na base", () => {
    const jaExiste = (arquivo: string): boolean => arquivo === "prova/stop-gate.ts";
    expect(
      soDeclaracaoDeProvaExistenteEditada(
        [".claude/hooks/README.md", "prova/stop-gate.ts"],
        jaExiste,
      ),
    ).toBe(true);
  });

  it("não SKIP quando a declaração de prova é NOVA (ausente na base)", () => {
    const jaExiste = (): boolean => false;
    expect(soDeclaracaoDeProvaExistenteEditada(["prova/novo-slug.ts"], jaExiste)).toBe(false);
  });

  it("não SKIP quando há qualquer tests/**, src/** ou scripts/** (fora de scripts/github/) no diff", () => {
    const jaExiste = (): boolean => true;
    expect(
      soDeclaracaoDeProvaExistenteEditada(["prova/stop-gate.ts", "tests/algo.test.ts"], jaExiste),
    ).toBe(false);
    expect(soDeclaracaoDeProvaExistenteEditada(["prova/stop-gate.ts", "src/x.ts"], jaExiste)).toBe(
      false,
    );
  });

  it("false quando não sobra nada fora de docs/process (deveSerIgnorado já cobre esse caso)", () => {
    const jaExiste = (): boolean => true;
    expect(soDeclaracaoDeProvaExistenteEditada(["docs/a.md"], jaExiste)).toBe(false);
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

describe("TIMEOUT_PROVA_MS (issue #62 — rodarProvaNaBase sem timeout)", () => {
  it("é 10 minutos em milissegundos", () => {
    expect(TIMEOUT_PROVA_MS).toBe(10 * 60 * 1000);
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

describe("commitsQueTocamTestes / commitAdicionaStub (git injetado — causa nunca engolida, issue #62)", () => {
  it("commitsQueTocamTestes: [] quando testFiles é vazio, sem chamar git", () => {
    const chamadas: string[][] = [];
    const resultado = commitsQueTocamTestes(
      (args) => {
        chamadas.push([...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      "base",
      "head",
      [],
    );
    expect(resultado).toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it("commitsQueTocamTestes: parseia sha\\x01subject por linha quando git log sai 0", () => {
    const resultado = commitsQueTocamTestes(
      () => ({
        status: 0,
        stdout: "aaa\x01test(red): cobre x\nbbb\x01fix: ajuste\n",
        stderr: "",
      }),
      "base",
      "head",
      ["tests/x.test.ts"],
    );
    expect(resultado).toEqual([
      { sha: "aaa", subject: "test(red): cobre x" },
      { sha: "bbb", subject: "fix: ajuste" },
    ]);
  });

  it("commitsQueTocamTestes: lança com a causa (nunca engole) quando git log falha de verdade", () => {
    expect(() =>
      commitsQueTocamTestes(
        () => ({ status: 128, stdout: "", stderr: "fatal: bad revision 'base..head'" }),
        "base",
        "head",
        ["tests/x.test.ts"],
      ),
    ).toThrow(/fatal: bad revision/);
  });

  it("commitAdicionaStub: false sem chamar git quando não há arquivo não-teste", () => {
    const chamadas: string[][] = [];
    const resultado = commitAdicionaStub(
      (args) => {
        chamadas.push([...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
      "aaa",
      [],
    );
    expect(resultado).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("commitAdicionaStub: lança com a causa quando git show falha de verdade", () => {
    expect(() =>
      commitAdicionaStub(
        () => ({ status: 128, stdout: "", stderr: "fatal: bad object aaa" }),
        "aaa",
        ["src/x.ts"],
      ),
    ).toThrow(/fatal: bad object/);
  });
});
