// Bancada do check `escopo` (issue #49, épico #34): o diff da PR precisa
// caber nos globs que a `## Files` da issue declara, mais o que a PR
// autorizar com `authorised:`. As funções puras (`globs.ts`,
// `escopo/lib.ts`) são testadas por chamada direta; `run.ts` é testado em
// subprocesso, modo dry-run (`--files-file`/`--issue-body-file`/
// `--pr-body-file`), sem `gh`/`git`.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { casa, globParaRegex } from "../scripts/ci/lib/globs.js";
import { appendSummary } from "../scripts/ci/lib/summary.js";
import {
  checarEscopo,
  extrairSecao,
  globsAutorizados,
  globsDaIssue,
} from "../scripts/ci/escopo/lib.js";

const root = resolve(import.meta.dirname, "..");
const runScript = resolve(root, "scripts/ci/escopo/run.ts");
const tsxBin = resolve(root, "node_modules/.bin/tsx");

describe("globs (globParaRegex, casa)", () => {
  it("`src/x/**` casa `src/x/a/b.ts` e não `src/y/a.ts`", () => {
    expect(casa("src/x/**", "src/x/a/b.ts")).toBe(true);
    expect(casa("src/x/**", "src/y/a.ts")).toBe(false);
  });

  it("`tests/x*.test.ts` casa `tests/x1.test.ts` e não `tests/x/1.test.ts`", () => {
    expect(casa("tests/x*.test.ts", "tests/x1.test.ts")).toBe(true);
    expect(casa("tests/x*.test.ts", "tests/x/1.test.ts")).toBe(false);
  });

  it("literal casa só o caminho exato", () => {
    expect(casa("package.json", "package.json")).toBe(true);
    expect(casa("package.json", "package2.json")).toBe(false);
    expect(casa("package.json", "src/package.json")).toBe(false);
  });

  it("globParaRegex produz uma RegExp ancorada (^...$)", () => {
    const re = globParaRegex("src/**");
    expect(re.test("src/a/b.ts")).toBe(true);
    expect(re.test("outro/a.ts")).toBe(false);
    expect(re.source.startsWith("^")).toBe(true);
    expect(re.source.endsWith("$")).toBe(true);
  });

  it("`**` casa qualquer número de segmentos aninhados", () => {
    expect(casa("src/x/**", "src/x/a/b/c.ts")).toBe(true);
    expect(casa("src/x/**", "src/x/a.ts")).toBe(true);
  });
});

describe("summary (appendSummary)", () => {
  const antigo = process.env["GITHUB_STEP_SUMMARY"];
  afterEach(() => {
    if (antigo === undefined) delete process.env["GITHUB_STEP_SUMMARY"];
    else process.env["GITHUB_STEP_SUMMARY"] = antigo;
  });

  it("no-op quando GITHUB_STEP_SUMMARY não está definido", () => {
    delete process.env["GITHUB_STEP_SUMMARY"];
    expect(() => {
      appendSummary("# título");
    }).not.toThrow();
  });

  it("escreve (append) no arquivo quando GITHUB_STEP_SUMMARY está definido", () => {
    const dir = mkdtempSync(join(tmpdir(), "lohra-ci-summary-"));
    const arquivo = join(dir, "summary.md");
    writeFileSync(arquivo, "");
    process.env["GITHUB_STEP_SUMMARY"] = arquivo;
    appendSummary("## um");
    appendSummary("## dois");
    const conteudo = readFileSync(arquivo, "utf8");
    expect(conteudo).toContain("## um");
    expect(conteudo).toContain("## dois");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("escopo/lib.ts — extrairSecao", () => {
  it("extrai o conteúdo entre o heading e o próximo '## '", () => {
    const body = ["## A", "x", "## Files", "- linha1", "- linha2", "## B", "y"].join("\n");
    expect(extrairSecao(body, "## Files")).toBe("- linha1\n- linha2");
  });

  it("aceita heading com sufixo — '## Files (da issue #44)'", () => {
    const body = ["## Files (da issue #44)", "- `a/**`", "## Outra"].join("\n");
    expect(extrairSecao(body, "## Files")).toBe("- `a/**`");
  });

  it("retorna null quando a seção não existe", () => {
    expect(extrairSecao(["## A", "x"].join("\n"), "## Files")).toBeNull();
  });

  it("seção no final do corpo, sem próximo heading", () => {
    expect(extrairSecao(["## Files", "- `a/**`"].join("\n"), "## Files")).toBe("- `a/**`");
  });

  it("não confunde '## FilesExtra' com '## Files'", () => {
    const body = ["## FilesExtra", "- `a/**`"].join("\n");
    expect(extrairSecao(body, "## Files")).toBeNull();
  });
});

describe("escopo/lib.ts — globsDaIssue", () => {
  it("lê só spans em crase dentro de bullets, várias por linha", () => {
    const body = [
      "## Files",
      "",
      "- `src/x/**`, `tests/x*.test.ts`",
      "- `prova/escopo.ts`",
      "",
      "## Fora de escopo",
    ].join("\n");
    expect(globsDaIssue(body)).toEqual(["src/x/**", "tests/x*.test.ts", "prova/escopo.ts"]);
  });

  it("ignora prosa sem crase (linhas de bullet sem span, ou fora de bullet)", () => {
    const body = [
      "## Files",
      "",
      "- Globs que a PR pode tocar",
      "- ver nota acima",
      "não é bullet: `nem/isso/conta`",
      "",
    ].join("\n");
    expect(globsDaIssue(body)).toEqual([]);
  });

  it("retorna [] quando a issue não declara '## Files'", () => {
    expect(globsDaIssue(["## Outra", "prosa"].join("\n"))).toEqual([]);
  });
});

describe("escopo/lib.ts — globsAutorizados", () => {
  it("só lê linhas 'authorised:' (bullet), ignora o resto da seção", () => {
    const body = [
      "## Files (da issue #49)",
      "",
      "- `scripts/ci/lib/**`, `scripts/ci/escopo/**`",
      "- authorised: `package.json`",
      "",
    ].join("\n");
    expect(globsAutorizados(body)).toEqual(["package.json"]);
  });

  it("ignora a seção inteira quando não há 'authorised:'", () => {
    const body = ["## Files", "", "- `a/**`", "- nota qualquer"].join("\n");
    expect(globsAutorizados(body)).toEqual([]);
  });

  it("aceita authorised: sem crase — primeiro token é o glob, o resto é prosa", () => {
    const body = ["## Files", "", "- authorised: package.json — issue #43, comentário"].join("\n");
    expect(globsAutorizados(body)).toEqual(["package.json"]);
  });

  it("authorised: com múltiplos globs em crase na mesma linha", () => {
    const body = ["## Files", "", "authorised: `a.ts`, `b.ts`"].join("\n");
    expect(globsAutorizados(body)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("escopo/lib.ts — checarEscopo", () => {
  it("ok:true quando todo arquivo casa com algum glob da issue", () => {
    const r = checarEscopo({ files: ["src/x/a.ts", "src/x/b/c.ts"], issueGlobs: ["src/x/**"] });
    expect(r).toEqual({ ok: true, fora: [] });
  });

  it("ok:false com 'fora' listando os arquivos que não casam", () => {
    const r = checarEscopo({
      files: ["src/x/a.ts", "src/y/b.ts", "src/z/c.ts"],
      issueGlobs: ["src/x/**"],
    });
    expect(r.ok).toBe(false);
    expect(r.fora).toEqual(["src/y/b.ts", "src/z/c.ts"]);
  });

  it("'authorised' cobre um arquivo fora dos globs da issue", () => {
    const r = checarEscopo({
      files: ["src/x/a.ts", "package.json"],
      issueGlobs: ["src/x/**"],
      authorised: ["package.json"],
    });
    expect(r).toEqual({ ok: true, fora: [] });
  });

  it("issue sem globs declarados: tudo fica 'fora' (falha limpa, não silenciosa)", () => {
    const r = checarEscopo({ files: ["qualquer.ts"], issueGlobs: [] });
    expect(r).toEqual({ ok: false, fora: ["qualquer.ts"] });
  });
});

describe("escopo/run.ts (dry-run, subprocesso)", () => {
  const workdirs: string[] = [];

  afterEach(() => {
    while (workdirs.length > 0) {
      const dir = workdirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function workdir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lohra-ci-escopo-"));
    workdirs.push(dir);
    return dir;
  }

  function escrever(dir: string, nome: string, conteudo: string): string {
    const caminho = join(dir, nome);
    writeFileSync(caminho, conteudo);
    return caminho;
  }

  function rodar(args: readonly string[]): SpawnSyncReturns<string> {
    // Nunca herda GITHUB_EVENT_PATH/GITHUB_STEP_SUMMARY do ambiente real do
    // CI que roda esta própria suíte — senão o subprocesso escreveria no
    // job summary de verdade e o modo dry-run deixaria de ser hermético.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "GITHUB_EVENT_PATH" && key !== "GITHUB_STEP_SUMMARY",
      ),
    );
    return spawnSync(tsxBin, [runScript, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
  }

  it("fixture fora dos globs da issue: exit 1 listando os arquivos", () => {
    const dir = workdir();
    const filesFile = escrever(dir, "files.txt", "scripts/ci/lib/globs.ts\nsrc/outro.ts\n");
    const issueBodyFile = escrever(
      dir,
      "issue.md",
      ["## Files", "", "- `scripts/ci/lib/**`", ""].join("\n"),
    );
    const prBodyFile = escrever(dir, "pr.md", "Resumo\n\nCloses #49\n");

    const r = rodar([
      "--files-file",
      filesFile,
      "--issue-body-file",
      issueBodyFile,
      "--pr-body-file",
      prBodyFile,
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/outro.ts");
    expect(r.stderr).not.toContain("scripts/ci/lib/globs.ts");
  });

  it("fixture dentro dos globs da issue: exit 0", () => {
    const dir = workdir();
    const filesFile = escrever(
      dir,
      "files.txt",
      "scripts/ci/lib/globs.ts\nscripts/ci/escopo/run.ts\n",
    );
    const issueBodyFile = escrever(dir, "issue.md", ["## Files", "", "- `scripts/ci/**`", ""].join("\n"));
    const prBodyFile = escrever(dir, "pr.md", "Closes #49\n");

    const r = rodar([
      "--files-file",
      filesFile,
      "--issue-body-file",
      issueBodyFile,
      "--pr-body-file",
      prBodyFile,
    ]);

    expect(r.status).toBe(0);
  });

  it("authorised: na PR cobre um arquivo fora do glob da issue: exit 0", () => {
    const dir = workdir();
    const filesFile = escrever(dir, "files.txt", "scripts/ci/lib/globs.ts\npackage.json\n");
    const issueBodyFile = escrever(dir, "issue.md", ["## Files", "", "- `scripts/ci/lib/**`", ""].join("\n"));
    const prBodyFile = escrever(
      dir,
      "pr.md",
      ["Closes #49", "", "## Files (da issue #49)", "", "- authorised: `package.json`", ""].join(
        "\n",
      ),
    );

    const r = rodar([
      "--files-file",
      filesFile,
      "--issue-body-file",
      issueBodyFile,
      "--pr-body-file",
      prBodyFile,
    ]);

    expect(r.status).toBe(0);
  });

  it("PR sem 'Closes #N': exit 1 com mensagem limpa, sem stack trace", () => {
    const dir = workdir();
    const filesFile = escrever(dir, "files.txt", "a.ts\n");
    const prBodyFile = escrever(dir, "pr.md", "## Resumo\n\nmuda x\n");

    const r = rodar(["--files-file", filesFile, "--pr-body-file", prBodyFile]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("escopo:");
    expect(r.stderr.toLowerCase()).toMatch(/closes/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain("not implemented");
  });
});
