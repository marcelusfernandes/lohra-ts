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
//     linhas, exceto `tests/fixtures/**` e `docs/reference/**` — só reprova
//     arquivo novo ou que cresceu em relação à base (issue #93). No modo CI,
//     a base vem de `git show <base>:<arquivo>` (`null` se o arquivo não
//     existia lá — arquivo novo). No modo `--files-file` (dry-run, sem
//     conceito de base) todo arquivo é tratado como novo, fail-closed, com
//     aviso no stderr de que a comparação com a base só existe no CI.
//
// Nota sobre os MARCADORES: a issue #50 cita `src/python-json.ts` e
// `src/python-repr.ts`; hoje (#17 ainda aberta) os módulos vivem em
// `src/serialization/python-json.ts` e `src/serialization/python-repr.ts`.
// Usamos o caminho real: checar o caminho da issue literalmente deixaria a
// regra ligada por default HOJE (o arquivo `src/python-json.ts` nunca
// existiu nesse nome), o que contraria o próprio objetivo declarado na
// issue — manter `import-proibido` desligada por default enquanto os
// módulos ainda existem. Quando #17 remover os módulos, os MARCADORES
// somem e a regra liga sozinha, sem precisar de `--apos-17`.
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
// `GITHUB_EVENT_PATH` nem `--files-file`, ou JSON de evento inválido). Se
// `GITHUB_STEP_SUMMARY` estiver definida, um resumo em markdown é anexado lá
// via `../lib/summary.js` (compartilhado com `controle-negativo` e
// `escopo`); senão, no-op. Um `GITHUB_STEP_SUMMARY` não gravável NÃO é erro
// de infra deste check (issue #78, alinhado com `controle-negativo`): a
// causa vai pro stderr e o exit code segue o resultado das regras (0/1) —
// nunca vira 2 por conta disso.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { causaGit, git, gitDiffNames } from "../lib/git.js";
import { appendSummary } from "../lib/summary.js";
import { ID_IMPORT_PROIBIDO, rodarContratos, type Violacao } from "./lib.js";

const MARCADORES_PYTHON_SERIALIZATION = [
  "src/serialization/python-json.ts",
  "src/serialization/python-repr.ts",
];

interface Argumentos {
  readonly filesFile?: string;
  readonly root?: string;
  readonly apos17: boolean;
}

function falhaFechada(mensagem: string): never {
  process.stderr.write(`contratos: ${mensagem}\n`);
  process.exit(2);
}

const USO = "uso: contratos [--files-file <arquivo>] [--root <dir>] [--apos-17]";
const FLAGS_CONHECIDAS = new Set(["--files-file", "--root", "--apos-17"]);

/** Flag desconhecida (issue #62): antes era silenciosamente ignorada — um
 * typo (`--apos17` sem hífen, por exemplo) desligava `import-proibido` sem
 * avisar ninguém. Agora é erro de uso, exit 2. */
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
    } else if (arg !== undefined && !FLAGS_CONHECIDAS.has(arg)) {
      falhaFechada(`flag desconhecida: ${arg} — ${USO}`);
    }
  }
  return {
    ...(filesFile !== undefined ? { filesFile } : {}),
    ...(root !== undefined ? { root } : {}),
    apos17,
  };
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
  /** Conteúdo do arquivo na base (issue #93) — `null` quando o arquivo é
   * novo (não existia na base). No modo dry-run (`--files-file`, sem
   * conceito de base) sempre `null`: `montarFonteDryRun` avisa no stderr. */
  readonly lerConteudoBase: (arquivo: string) => string | null;
  readonly marcadorExiste: (marcador: string) => boolean;
}

function montarFonteDryRun(args: Argumentos): FonteDeDados {
  if (args.filesFile === undefined) {
    falhaFechada("dry-run precisa de --files-file <arquivo>");
  }
  const root = resolve(args.root ?? process.cwd());
  const files = linhasDeArquivo(args.filesFile);
  process.stderr.write(
    "contratos: --files-file não tem base — arquivo-grande trata todo arquivo " +
      "como novo (fail-closed); a comparação com a base só existe no CI\n",
  );
  return {
    root,
    files,
    lerConteudo: (arquivo) => {
      const caminho = join(root, arquivo);
      if (!existsSync(caminho)) return null;
      return readFileSync(caminho, "utf8");
    },
    lerConteudoBase: () => null,
    marcadorExiste: (marcador) => existsSync(join(root, marcador)),
  };
}

interface EventoPullRequest {
  readonly pull_request?: {
    readonly base?: { readonly sha?: string };
    readonly head?: { readonly sha?: string };
  };
}

/** `JSON.parse` de um evento malformado lançava sem `try` — o processo
 * morria com uma exceção não tratada (exit 1 do próprio Node), nunca o
 * exit 2 que o contrato deste script promete para erro de infra (issue
 * #62). `montarFonteCi` sempre chama isto dentro de um `try`. */
function lerEventoPullRequest(eventPath: string): EventoPullRequest {
  const bruto: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  return bruto as EventoPullRequest;
}

function montarFonteCi(root: string): FonteDeDados {
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "" || !existsSync(eventPath)) {
    falhaFechada(
      "modo CI precisa de GITHUB_EVENT_PATH (evento pull_request) — ou use --files-file para dry-run",
    );
  }
  let evento: EventoPullRequest;
  try {
    evento = lerEventoPullRequest(eventPath);
  } catch (erro) {
    falhaFechada(
      `${eventPath} não é um evento pull_request válido (JSON inválido): ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }
  const baseBruto = evento.pull_request?.base?.sha;
  const headBruto = evento.pull_request?.head?.sha;
  if (typeof baseBruto !== "string" || typeof headBruto !== "string") {
    falhaFechada(`${eventPath} não tem pull_request.base.sha/head.sha (string)`);
  }
  // Reatribuídos a consts próprios (em vez de usar `baseBruto`/`headBruto`
  // direto): a checagem acima só narrowa o tipo no escopo léxico deste
  // bloco — dentro de `existeNoHead`, uma função declarada mais abaixo, o
  // TypeScript volta a ver `string | undefined` no closure.
  const base: string = baseBruto;
  const head: string = headBruto;

  // `gitDiffNames` (`../lib/git.js`, issue #62): `-z` nunca escapa um
  // caminho não-ASCII, e a causa completa (ENOENT/exit/sinal/stderr) nunca
  // se perde quando o comando falha.
  let files: readonly string[];
  try {
    files = gitDiffNames(root, base, head);
  } catch (erro) {
    falhaFechada(erro instanceof Error ? erro.message : String(erro));
  }

  function existeNoHead(caminho: string): boolean {
    return git(root, ["cat-file", "-e", `${head}:${caminho}`]).status === 0;
  }

  function existeNaBase(caminho: string): boolean {
    return git(root, ["cat-file", "-e", `${base}:${caminho}`]).status === 0;
  }

  return {
    root,
    files,
    lerConteudo: (arquivo) => {
      if (!existeNoHead(arquivo)) return null;
      const mostrado = git(root, ["show", `${head}:${arquivo}`]);
      if (mostrado.error !== undefined || mostrado.status !== 0) {
        falhaFechada(
          `git show ${head}:${arquivo} falhou apesar de existir no head: ${causaGit(mostrado)}`,
        );
      }
      return mostrado.stdout;
    },
    // Issue #93: `null` quando o arquivo não existe na base — arquivo novo,
    // a regra `arquivo-grande` trata isso como "sempre viola se > 800".
    lerConteudoBase: (arquivo) => {
      if (!existeNaBase(arquivo)) return null;
      const mostrado = git(root, ["show", `${base}:${arquivo}`]);
      if (mostrado.error !== undefined || mostrado.status !== 0) {
        falhaFechada(
          `git show ${base}:${arquivo} falhou apesar de existir na base: ${causaGit(mostrado)}`,
        );
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

/** Resumo em markdown do resultado de `contratos` — a escrita em si
 * (incluindo o que fazer se `GITHUB_STEP_SUMMARY` não for gravável) é
 * responsabilidade de `appendSummary` (`../lib/summary.js`, issue #78):
 * nunca lança, nunca faz este check sair 2 por uma falha de infra do
 * runner. As violações (se houver) já foram escritas em stderr por `main`
 * ANTES de chamar isto — nunca ficam sem relatar só porque o summary
 * falhou. */
function resumoMarkdown(ok: boolean, violacoes: readonly Violacao[]): string {
  const linhas = [
    "## contratos",
    "",
    ok ? "Nenhuma violação." : "**FAILED**:",
    ...violacoes.map((v) => `- \`${v.arquivo}\` — ${v.id}: ${v.descricao}`),
    "",
  ];
  return linhas.join("\n");
}

function main(): void {
  const args = analisarArgumentos(process.argv.slice(2));
  const fonte =
    args.filesFile !== undefined ? montarFonteDryRun(args) : montarFonteCi(resolve(process.cwd()));

  const ativo = ehImportProibidoAtivo(args, fonte);
  const todasAsViolacoes = rodarContratos(fonte.files, fonte.lerConteudo, fonte.lerConteudoBase);
  const violacoes = todasAsViolacoes.filter((v) => v.id !== ID_IMPORT_PROIBIDO || ativo);
  const ok = violacoes.length === 0;

  if (!ok) {
    process.stderr.write(`${violacoes.map(formatarViolacao).join("\n")}\n`);
  }

  appendSummary(resumoMarkdown(ok, violacoes));

  if (!ok) {
    process.exit(1);
  }
  process.stdout.write(`contratos: ${String(fonte.files.length)} arquivo(s), nenhuma violação\n`);
  process.exit(0);
}

main();
