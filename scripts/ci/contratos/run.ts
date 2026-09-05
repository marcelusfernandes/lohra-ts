#!/usr/bin/env node
// `contratos` check (issue #50): aplica `regras` (lib.ts) aos arquivos de um
// diff — três invariantes do CLAUDE.md:
//   - `caminho-proibido`: `docs/reference/**`/`lohra/**` (histórico, não
//     editável), remoção conta também.
//   - `import-proibido`: import/require/import() de `python-json`/
//     `python-repr` fora de `src/**`, `scripts/**`, `tests/**` (exceto
//     `scripts/ci/**` e `tests/ci-*.test.ts`, auto-exclusão — ver lib.ts).
//     Ligada por `--apos-17`, ou por default quando NENHUM dos MARCADORES
//     abaixo existe no head/root (ver nota).
//   - `arquivo-grande`: `.ts`/`.mjs`/`.sh`/`.md` do diff com mais de 800
//     linhas, exceto `tests/fixtures/**` e `docs/reference/**`.
//
// Nota sobre os MARCADORES: a issue #50 cita `src/python-json.ts` e
// `src/python-repr.ts`; hoje (checado em 2026-09) os módulos vivem em
// `src/serialization/python-json.ts` e `src/serialization/python-repr.ts`
// (#17 ainda aberta, ver `docs/reference` não — ver issue #17). Usamos o
// caminho real: checar o caminho da issue literalmente deixaria a regra
// ligada por default HOJE (o arquivo `src/python-json.ts` nunca existiu
// nesse nome), o que contraria o próprio objetivo declarado na issue —
// manter `import-proibido` desligada por default enquanto os módulos ainda
// existem. Quando #17 remover os módulos, os MARCADORES somem e a regra
// liga sozinha, sem precisar de `--apos-17`.
//
// Dois modos:
//   - CI: lê `GITHUB_EVENT_PATH` (evento `pull_request`), roda
//     `git diff --no-renames --name-only base...head` e lê cada arquivo com
//     `git show head:<arquivo>` (null se não existir no head — arquivo
//     removido). Os MARCADORES são checados com `git cat-file -e head:<m>`.
//   - Dry-run: `--files-file <arquivo>` (uma linha por caminho) e `--root
//     <dir>` (default cwd); lê e checa os MARCADORES direto no filesystem.
//     `--apos-17` força `import-proibido` ligada nos dois modos.
//
// Saída: `id: arquivo — descrição` por violação, em stderr; exit 1 se houver
// violação, exit 0 se não, exit 2 em erro de uso/infra (ex.: nem
// `GITHUB_EVENT_PATH` nem `--files-file`). Se `GITHUB_STEP_SUMMARY` estiver
// definida, um resumo em markdown é anexado lá; senão, no-op.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { rodarContratos, type Violacao } from "./lib.js";

const MARCADORES_PYTHON_SERIALIZATION = [
  "src/serialization/python-json.ts",
  "src/serialization/python-repr.ts",
];

interface Argumentos {
  readonly filesFile?: string;
  readonly root?: string;
  readonly apos17: boolean;
}

function analisarArgumentos(argv: readonly string[]): Argumentos {
  let filesFile: string | undefined;
  let root: string | undefined;
  let apos17 = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--files-file") {
      i += 1;
      filesFile = argv[i];
    } else if (arg === "--root") {
      i += 1;
      root = argv[i];
    } else if (arg === "--apos-17") {
      apos17 = true;
    }
  }
  return {
    ...(filesFile !== undefined ? { filesFile } : {}),
    ...(root !== undefined ? { root } : {}),
    apos17,
  };
}

function falhaFechada(mensagem: string): never {
  process.stderr.write(`contratos: ${mensagem}\n`);
  process.exit(2);
}

function linhasDeArquivo(caminho: string): readonly string[] {
  return readFileSync(caminho, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

interface FonteDeDados {
  readonly root: string;
  readonly files: readonly string[];
  readonly lerConteudo: (arquivo: string) => string | null;
  readonly marcadorExiste: (marcador: string) => boolean;
}

function montarFonteDryRun(args: Argumentos): FonteDeDados {
  if (args.filesFile === undefined) {
    falhaFechada("dry-run precisa de --files-file <arquivo>");
  }
  const root = resolve(args.root ?? process.cwd());
  const files = linhasDeArquivo(args.filesFile);
  return {
    root,
    files,
    lerConteudo: (arquivo) => {
      const caminho = join(root, arquivo);
      if (!existsSync(caminho)) return null;
      return readFileSync(caminho, "utf8");
    },
    marcadorExiste: (marcador) => existsSync(join(root, marcador)),
  };
}

interface EventoPullRequest {
  readonly pull_request?: {
    readonly base?: { readonly sha?: string };
    readonly head?: { readonly sha?: string };
  };
}

function lerEventoPullRequest(eventPath: string): EventoPullRequest {
  const bruto: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  return bruto as EventoPullRequest;
}

function git(root: string, args: readonly string[]): { status: number; stdout: string } {
  const resultado = spawnSync("git", args as string[], { cwd: root, encoding: "utf8" });
  if (resultado.error !== undefined) {
    falhaFechada(`git ${args.join(" ")} falhou: ${resultado.error.message}`);
  }
  return { status: resultado.status ?? 1, stdout: resultado.stdout };
}

function montarFonteCi(root: string): FonteDeDados {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "" || !existsSync(eventPath)) {
    falhaFechada(
      "modo CI precisa de GITHUB_EVENT_PATH (evento pull_request) — ou use --files-file para dry-run",
    );
  }
  const evento = lerEventoPullRequest(eventPath);
  const baseBruto = evento.pull_request?.base?.sha;
  const headBruto = evento.pull_request?.head?.sha;
  if (baseBruto === undefined || headBruto === undefined) {
    falhaFechada(`${eventPath} não tem pull_request.base.sha/head.sha`);
  }
  // Reatribuídos a consts próprios (em vez de usar `baseBruto`/`headBruto`
  // direto): a checagem acima só narrowa o tipo no escopo léxico deste
  // bloco — dentro de `existeNoHead`, uma função declarada mais abaixo, o
  // TypeScript volta a ver `string | undefined` no closure.
  const base: string = baseBruto;
  const head: string = headBruto;

  const diff = git(root, ["diff", "--no-renames", "--name-only", `${base}...${head}`]);
  if (diff.status !== 0) {
    falhaFechada(`git diff ${base}...${head} falhou (status ${String(diff.status)})`);
  }
  const files = diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  function existeNoHead(caminho: string): boolean {
    return git(root, ["cat-file", "-e", `${head}:${caminho}`]).status === 0;
  }

  return {
    root,
    files,
    lerConteudo: (arquivo) => {
      if (!existeNoHead(arquivo)) return null;
      const mostrado = git(root, ["show", `${head}:${arquivo}`]);
      if (mostrado.status !== 0) {
        falhaFechada(`git show ${head}:${arquivo} falhou apesar de existir no head`);
      }
      return mostrado.stdout;
    },
    marcadorExiste: existeNoHead,
  };
}

function ehImportProibidoAtivo(args: Argumentos, fonte: FonteDeDados): boolean {
  if (args.apos17) return true;
  return !MARCADORES_PYTHON_SERIALIZATION.some((marcador) => fonte.marcadorExiste(marcador));
}

function formatarViolacao(v: Violacao): string {
  return `${v.id}: ${v.arquivo} — ${v.descricao}`;
}

function escreverSummary(ok: boolean, violacoes: readonly Violacao[]): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath === "") return;
  const linhas = [
    "## contratos",
    "",
    ok ? "Nenhuma violação." : "**FAILED**:",
    ...violacoes.map((v) => `- \`${v.arquivo}\` — ${v.id}: ${v.descricao}`),
    "",
  ];
  appendFileSync(summaryPath, `${linhas.join("\n")}\n`);
}

function main(): void {
  const args = analisarArgumentos(process.argv.slice(2));
  const fonte =
    args.filesFile !== undefined ? montarFonteDryRun(args) : montarFonteCi(resolve(process.cwd()));

  const ativo = ehImportProibidoAtivo(args, fonte);
  const todasAsViolacoes = rodarContratos(fonte.files, fonte.lerConteudo);
  const violacoes = todasAsViolacoes.filter((v) => v.id !== "import-proibido" || ativo);

  const ok = violacoes.length === 0;
  escreverSummary(ok, violacoes);

  if (!ok) {
    process.stderr.write(`${violacoes.map(formatarViolacao).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`contratos: ${String(fonte.files.length)} arquivo(s), nenhuma violação\n`);
  process.exit(0);
}

main();
