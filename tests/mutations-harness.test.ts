// Testes do harness comum de mutação (issue #148, passo 0a do épico #13).
// Cobre: âncora única/ambígua/ausente, restore byte a byte, classificação,
// e `prepareArchiveSandbox` contra um repositório git temporário (molde:
// `tests/helpers/controle-negativo-repo.ts` `novoRepo`/`commitTudo`, mas com
// um helper próprio aqui porque o formato do repo fake é diferente — não há
// `package.json`/script de prova envolvido, só arquivos e commits).
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyEditExactlyOnce,
  classify,
  parseVitestOutcome,
  prepareArchiveSandbox,
  replaceExactlyOnce,
  restoreAll,
  snapshotFiles,
  writeReport,
} from "../scripts/mutations/harness.js";
import type { MutationReport } from "../scripts/mutations/types.js";

const repoRoot = resolve(import.meta.dirname, "..");
const harnessSource = readFileSync(resolve(repoRoot, "scripts/mutations/harness.ts"), "utf8");

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
}

function gitCapture(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
  return result.stdout.trim();
}

function novoRepoGit(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutations-harness-"));
  workdirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "prova@example.com"]);
  git(dir, ["config", "user.name", "Prova"]);
  return dir;
}

describe("replaceExactlyOnce", () => {
  it("substitui uma âncora única", () => {
    const result = replaceExactlyOnce(
      "const a = 1;\nconst b = 2;\n",
      "const a = 1;",
      "const a = 2;",
      "id-1",
    );
    expect(result).toBe("const a = 2;\nconst b = 2;\n");
  });

  it("lança com causa quando a âncora não ocorre", () => {
    expect(() =>
      replaceExactlyOnce("const a = 1;\n", "const z = 9;", "const z = 0;", "id-2"),
    ).toThrow(/id-2.*anchor.*not found/i);
  });

  it("lança com causa quando a âncora ocorre mais de uma vez", () => {
    expect(() =>
      replaceExactlyOnce("const a = 1;\nconst a = 1;\n", "const a = 1;", "const a = 2;", "id-3"),
    ).toThrow(/id-3.*anchor.*not unique/i);
  });
});

describe("applyEditExactlyOnce", () => {
  it("lê o arquivo, aplica a substituição e escreve de volta", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutations-harness-apply-"));
    workdirs.push(dir);
    writeFileSync(join(dir, "alvo.ts"), "export const x = 1;\n");
    applyEditExactlyOnce(dir, { file: "alvo.ts", before: "x = 1", after: "x = 2" }, "id-4");
    expect(readFileSync(join(dir, "alvo.ts"), "utf8")).toBe("export const x = 2;\n");
  });
});

describe("snapshotFiles / restoreAll", () => {
  it("restaura byte a byte: CRLF, sem newline final, e caractere não-ascii", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutations-harness-snapshot-"));
    workdirs.push(dir);
    const original = Buffer.from("linha1\r\nlinha2 – café", "utf8");
    writeFileSync(join(dir, "arquivo.txt"), original);

    const snapshot = snapshotFiles(dir, ["arquivo.txt"]);
    writeFileSync(join(dir, "arquivo.txt"), Buffer.from("mutado\n", "utf8"));
    restoreAll(dir, snapshot);

    const restored = readFileSync(join(dir, "arquivo.txt"));
    expect(Buffer.compare(restored, original)).toBe(0);
  });
});

describe("classify", () => {
  it.each([
    [0, [], false],
    [1, [], false],
    [0, ["teste"], false],
    [1, ["teste"], true],
  ] as const)("classify(%s, %j) -> killed=%s", (exitCode, failedTests, expected) => {
    expect(classify(exitCode, [...failedTests])).toBe(expected);
  });
});

describe("parseVitestOutcome", () => {
  it("extrai exitCode, testes falhados e total rodado do relatório json", () => {
    const stdout = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { status: "passed", fullName: "a passa" },
            { status: "failed", fullName: "b falha" },
            { status: "skipped", fullName: "c pulado" },
          ],
        },
      ],
    });
    const outcome = parseVitestOutcome(stdout, 1);
    expect(outcome).toEqual({ exitCode: 1, failedTests: ["b falha"], ranTests: 2 });
  });

  it("sem json no stdout, devolve marcador de relatório ausente", () => {
    const outcome = parseVitestOutcome("saída sem chaves balanceadas", 1);
    expect(outcome).toEqual({ exitCode: 1, failedTests: ["<no json report>"], ranTests: 0 });
  });
});

describe("writeReport", () => {
  it("escreve o shape MutationReport em mutations.json, canônico", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutations-harness-report-"));
    workdirs.push(dir);
    const report: MutationReport = {
      suite: "t148-harness",
      candidateSha: "deadbeef",
      killed: 1,
      total: 1,
      survivors: [],
      restoreGreen: true,
    };
    writeReport(dir, report);
    const written = JSON.parse(readFileSync(join(dir, "mutations.json"), "utf8")) as unknown;
    expect(written).toEqual(report);
    expect(Object.keys(written as object).sort()).toEqual(
      ["candidateSha", "killed", "restoreGreen", "suite", "survivors", "total"].sort(),
    );
  });
});

describe("prepareArchiveSandbox", () => {
  it("recusa git status --porcelain sujo", () => {
    const dir = novoRepoGit();
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "inicial"]);
    writeFileSync(join(dir, "a.txt"), "sujo\n");

    expect(() => prepareArchiveSandbox(dir, "HEAD")).toThrow(/porcelain/i);
  });

  it("arquiva exatamente a SHA pedida, não o working tree", () => {
    const dir = novoRepoGit();
    writeFileSync(join(dir, "a.txt"), "versao-1\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "v1"]);
    const shaV1 = gitCapture(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "a.txt"), "versao-2\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "v2"]);

    const sandbox = prepareArchiveSandbox(dir, shaV1);
    workdirs.push(sandbox);
    expect(readFileSync(join(sandbox, "a.txt"), "utf8")).toBe("versao-1\n");
  });

  it("cria o sandbox com symlink de node_modules apontando para a raiz", () => {
    const dir = novoRepoGit();
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "inicial"]);
    const sha = gitCapture(dir, ["rev-parse", "HEAD"]);

    const sandbox = prepareArchiveSandbox(dir, sha);
    workdirs.push(sandbox);
    const linkPath = join(sandbox, "node_modules");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(resolve(dir, "node_modules"));
  });

  it("não deixa sandbox órfão quando a SHA não existe", () => {
    const dir = novoRepoGit();
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "inicial"]);

    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("lohra-mutations-"));
    expect(() => prepareArchiveSandbox(dir, "0000000000000000000000000000000000000000")).toThrow();
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("lohra-mutations-"));
    expect(after).toEqual(before);
  });
});

describe("scripts/mutations não depende de scripts/parity", () => {
  it("harness.ts não importa nada de scripts/parity/**", () => {
    const importLines = harnessSource
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) || /from\s+["']/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/parity/);
    }
  });
});
