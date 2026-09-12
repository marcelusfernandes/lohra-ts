// Issue #530: `package.json` sem metadados de publicação (`repository`,
// `homepage`, `bugs`, `keywords`) e `scripts/postinstall.mjs` fazendo duas
// coisas que não deveriam estar no mesmo script: o `chmod` do
// `spawn-helper` do `node-pty` (precisa rodar em QUALQUER instalação de
// consumidor — tarball/registry, onde `prepare` nunca roda) e a instalação
// dos hooks de git/lefthook (só faz sentido em checkout de dev, nunca deve
// ir para o pacote publicado). Emenda de 2026-09-13: o `chmod` fica em
// `postinstall`; os hooks vão para `scripts/prepare.mjs`, fora de `files`.
//
// Este arquivo lê `package.json` direto e o tarball real via
// `npm pack --dry-run --json` — nunca confia só na declaração de `files`,
// porque a lista final do npm tem regras próprias (arquivos sempre
// incluídos como `package.json`, `.gitignore` etc.). `npm pack --dry-run`
// roda em qualquer estado de `dist/` (CI roda `npm test` ANTES de
// `npm run build`, README "Instalação" — ver `.github/workflows/ci.yml`),
// por isso nenhuma asserção aqui depende do conteúdo de `dist/`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

interface PackFileEntry {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFileEntry[];
}

/**
 * `npm pack` roda o lifecycle `prepare` mesmo com `--ignore-scripts`
 * (comportamento do npm 10 — a flag não suprime `prepare` na hora de
 * empacotar); `scripts/prepare.mjs` usa `stdio: "inherit"`, então a saída
 * dos instaladores de hook (git-pre-push, lefthook) vai para o mesmo stdout
 * do `npm pack --json`, antes do array. O array de verdade é sempre o
 * último bloco impresso, começando numa linha própria só com `[` — extrai a
 * partir daí em vez de tentar `JSON.parse` no stdout inteiro.
 */
function extrairArrayJson(stdout: string): string {
  const indice = stdout.lastIndexOf("\n[");
  if (indice !== -1) return stdout.slice(indice + 1);
  if (stdout.trimStart().startsWith("[")) return stdout;
  throw new Error("npm pack --dry-run --json: array JSON não encontrado no stdout");
}

function npmPackDryRun(): PackEntry {
  const resultado = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  if (resultado.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json falhou (exit ${String(resultado.status)}): ${resultado.stderr}`,
    );
  }
  const parsed = JSON.parse(extrairArrayJson(resultado.stdout)) as readonly PackEntry[];
  const entry = parsed[0];
  if (entry === undefined) throw new Error("npm pack --dry-run --json não devolveu entradas");
  return entry;
}

interface PackageJsonForm {
  readonly scripts?: Record<string, string>;
  readonly repository?: { readonly type: string; readonly url: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url: string };
  readonly keywords?: readonly string[];
}

function lerPackageJson(): PackageJsonForm {
  return JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as PackageJsonForm;
}

describe("package.json — metadados de publicação (issue #530)", () => {
  it("declara repository apontando exatamente para o repositório público", () => {
    const pkg = lerPackageJson();
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/marcelusfernandes/lohra-ts.git",
    });
  });

  it("declara homepage e bugs apontando para o GitHub", () => {
    const pkg = lerPackageJson();
    expect(pkg.homepage).toBe("https://github.com/marcelusfernandes/lohra-ts#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/marcelusfernandes/lohra-ts/issues" });
  });

  it("declara keywords não vazias", () => {
    const pkg = lerPackageJson();
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect((pkg.keywords ?? []).length).toBeGreaterThan(0);
  });
});

describe("package.json — split postinstall/prepare (issue #530)", () => {
  it("scripts.prepare instala os hooks (fora do que roda num tarball)", () => {
    const pkg = lerPackageJson();
    expect(pkg.scripts?.prepare).toBe("node scripts/prepare.mjs");
  });

  it("scripts.postinstall continua existindo, só para o chmod do node-pty", () => {
    const pkg = lerPackageJson();
    expect(pkg.scripts?.postinstall).toBe("node scripts/postinstall.mjs");
  });

  it("scripts/postinstall.mjs não referencia git nem lefthook — só o chmod do spawn-helper", () => {
    const conteudo = readFileSync(join(RAIZ, "scripts", "postinstall.mjs"), "utf8");
    // Checa o idioma de código real (spawn de processo, import de
    // child_process), não menções em prosa a ".git" — o comentário do
    // arquivo explica por que o chmod não pode ir para `prepare` citando
    // ".git", o que uma checagem textual ingênua confundiria com o
    // check-de-git que só devia existir em `prepare.mjs`.
    expect(conteudo).not.toContain("node:child_process");
    expect(conteudo).not.toContain("spawnSync");
    expect(conteudo.toLowerCase()).not.toContain("lefthook");
    expect(conteudo).toContain("spawn-helper");
  });

  it("scripts/prepare.mjs instala git-pre-push e lefthook, nunca o chmod do node-pty", () => {
    const conteudo = readFileSync(join(RAIZ, "scripts", "prepare.mjs"), "utf8");
    expect(conteudo).toContain("instalar-git-hooks.sh");
    expect(conteudo.toLowerCase()).toContain("lefthook");
    expect(conteudo).not.toContain("spawn-helper");
  });
});

describe("npm pack --dry-run --json — tarball publicado (issue #530)", () => {
  it("inclui scripts/postinstall.mjs mas não scripts/prepare.mjs, e nenhum outro arquivo sob scripts/", () => {
    const entry = npmPackDryRun();
    const scriptsFiles = entry.files
      .map((arquivo) => arquivo.path)
      .filter((caminho) => caminho.startsWith("scripts/"));
    expect(scriptsFiles).toEqual(["scripts/postinstall.mjs"]);
  });

  it("mantém README.md, LICENSE e docs/closeout.md na whitelist", () => {
    const entry = npmPackDryRun();
    const paths = entry.files.map((arquivo) => arquivo.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("docs/closeout.md");
  });
});
