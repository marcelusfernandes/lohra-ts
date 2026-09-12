// Bancada de `scripts/release.ts` (issue #531/D2) — repositório git
// temporário por teste (`mkdtemp` + `git init`, via
// `tests/helpers/controle-negativo-repo.ts`), sem rede.
//
// `scripts/release.ts` é um módulo NOVO: o `import` é feito DENTRO de cada
// `it()` (nunca no topo do arquivo) para o vermelho ser de runtime — uma
// asserção real do vitest — e não um erro estrutural de coleta
// (`worktree-segura` §7; o classificador do controle negativo,
// `scripts/ci/controle-negativo/lib.ts#classificar`, só aceita
// `structural-red` quando existe um `test(red):` válido; importar dentro do
// `it()` garante `assertion-red` diretamente).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitTudo,
  git,
  gitCapture,
  limparWorkdirs,
  novoRepo,
} from "./helpers/controle-negativo-repo.js";

afterEach(limparWorkdirs);

function criarRepoBase(version: string): string {
  const dir = novoRepo({
    packageJsonText: `${JSON.stringify({ name: "fake-release", version, scripts: {} }, null, 2)}\n`,
  });
  commitTudo(dir, "chore: estado inicial do repositório fake");
  return dir;
}

/** Cria uma branch de feature, um commit nela, e mergeia de volta em `main`
 * com `--no-ff` — a mesma topologia de PR merge commit que este repositório
 * usa de verdade (ADR 0004: merge commit, nunca squash). */
function commitPr(
  dir: string,
  numero: number,
  branch: string,
  titulo: string,
  arquivo: string,
): void {
  git(dir, ["checkout", "-b", branch]);
  writeFileSync(join(dir, arquivo), "conteudo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", `feat: commit em ${branch}`]);
  git(dir, ["checkout", "main"]);
  git(dir, [
    "merge",
    "--no-ff",
    "-m",
    `Merge pull request #${String(numero)} from fake/${branch}`,
    "-m",
    titulo,
    branch,
  ]);
}

describe("parseVersionArg / computeNextVersion", () => {
  it("bump patch/minor/major e versão explícita a partir da versão atual", async () => {
    const { computeNextVersion, parseVersionArg } = await import("../scripts/release.js");
    expect(computeNextVersion("1.2.3", parseVersionArg("patch"))).toBe("1.2.4");
    expect(computeNextVersion("1.2.3", parseVersionArg("minor"))).toBe("1.3.0");
    expect(computeNextVersion("1.2.3", parseVersionArg("major"))).toBe("2.0.0");
    expect(computeNextVersion("1.2.3", parseVersionArg("9.9.9"))).toBe("9.9.9");
  });

  it("recusa argumento de versão inválido", async () => {
    const { parseVersionArg } = await import("../scripts/release.js");
    expect(() => parseVersionArg("nope")).toThrow(/RELEASE_INVALID_VERSION/);
    expect(() => parseVersionArg(undefined)).toThrow(/RELEASE_INVALID_VERSION/);
  });
});

describe("runRelease — bump de ponta a ponta", () => {
  it("faz bump em package.json e package-lock.json (só as versões do pacote raiz) e commita", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    writeFileSync(
      join(dir, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "fake-release",
          version: "0.0.11",
          lockfileVersion: 3,
          packages: {
            "": { name: "fake-release", version: "0.0.11" },
            "node_modules/dep": { version: "9.9.9" },
          },
        },
        null,
        2,
      )}\n`,
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "chore: lockfile inicial"]);
    git(dir, ["checkout", "-b", "release/0.0.12"]);

    const result = runRelease({ cwd: dir, arg: "patch" });
    expect(result.version).toBe("0.0.12");
    expect(result.previousVersion).toBe("0.0.11");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe("0.0.12");

    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(lock.version).toBe("0.0.12");
    expect(lock.packages[""]?.version).toBe("0.0.12");
    expect(lock.packages["node_modules/dep"]?.version).toBe("9.9.9");

    const subject = gitCapture(dir, ["log", "-1", "--format=%s"]);
    expect(subject).toBe("chore(release): v0.0.12");

    const status = gitCapture(dir, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  it("gera a seção do CHANGELOG a partir dos merges e agrupa por tipo do título", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    commitPr(dir, 10, "feat/10-a", "feat(a): adiciona a", "a.txt");
    commitPr(dir, 11, "fix/11-b", "fix(b): corrige b", "b.txt");
    git(dir, ["checkout", "-b", "release/0.0.12"]);

    runRelease({ cwd: dir, arg: "patch" });

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [0.0.12]");
    expect(changelog).toContain("feat(a): adiciona a (#10)");
    expect(changelog).toContain("fix(b): corrige b (#11)");
    expect(changelog.indexOf("### Added")).toBeGreaterThan(-1);
    expect(changelog.indexOf("### Fixed")).toBeGreaterThan(-1);
    expect(changelog.indexOf("### Added")).toBeLessThan(changelog.indexOf("feat(a): adiciona a"));
  });

  it("changelog ignora o bloco '# Conflicts:' que o git anexa a merges resolvidos manualmente", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    git(dir, ["checkout", "-b", "feat/30-conflito"]);
    writeFileSync(join(dir, "c.txt"), "conteudo\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "feat: commit em feat/30-conflito"]);
    git(dir, ["checkout", "main"]);
    git(dir, [
      "merge",
      "--no-ff",
      "-m",
      "merge: integrate approved feat/30-conflito head (#30)",
      "-m",
      "# Conflicts:\n#\tc.txt",
      "feat/30-conflito",
    ]);
    git(dir, ["checkout", "-b", "release/0.0.12"]);

    runRelease({ cwd: dir, arg: "patch" });

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("merge: integrate approved feat/30-conflito head (#30)");
    expect(changelog).not.toContain("# Conflicts:");
  });

  it("changelog considera só os merges depois da última tag v*", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    commitPr(dir, 20, "feat/20-old", "feat(old): entra antes da tag", "old.txt");
    git(dir, ["tag", "-a", "v0.0.11", "-m", "v0.0.11"]);
    commitPr(dir, 21, "feat/21-new", "feat(new): entra depois da tag", "new.txt");
    git(dir, ["checkout", "-b", "release/0.0.12"]);

    runRelease({ cwd: dir, arg: "patch" });

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("feat(new): entra depois da tag (#21)");
    expect(changelog).not.toContain("feat(old): entra antes da tag");
  });

  it("recusa rodar na branch main", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    expect(() => runRelease({ cwd: dir, arg: "patch" })).toThrow(/RELEASE_BRANCH_MAIN/);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe("0.0.11");
  });

  it("recusa branch que não é release/<versão alvo>", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    git(dir, ["checkout", "-b", "feat/999-qualquer"]);
    expect(() => runRelease({ cwd: dir, arg: "patch" })).toThrow(/RELEASE_BRANCH_MISMATCH/);
  });

  it("recusa árvore de trabalho suja", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    git(dir, ["checkout", "-b", "release/0.0.12"]);
    writeFileSync(join(dir, "sujeira.txt"), "oops\n");
    expect(() => runRelease({ cwd: dir, arg: "patch" })).toThrow(/RELEASE_TREE_DIRTY/);
  });

  it("recusa versão de argumento inválida antes de tocar em qualquer arquivo", async () => {
    const { runRelease } = await import("../scripts/release.js");
    const dir = criarRepoBase("0.0.11");
    git(dir, ["checkout", "-b", "release/0.0.12"]);
    expect(() => runRelease({ cwd: dir, arg: "banana" })).toThrow(/RELEASE_INVALID_VERSION/);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe("0.0.11");
  });
});
