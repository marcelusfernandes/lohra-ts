#!/usr/bin/env node
// `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--root <dir>]`
// (issue #48) — prova que os testes novos de uma PR reprovam contra a base
// da PR, para que "teste primeiro" seja verificado por máquina, não só
// prometido no commit.
//
// Mecânica: `git worktree add --detach <tmp> <base>`, overlay só dos
// arquivos de teste do diff (`tests/**/*.test.ts`, `prova/**` —
// `lib.ts#arquivosDeTeste`) copiados do HEAD por cima da base, roda
// `npm run -s prova -- <slug>` NA BASE (o próprio código de produção da
// base, sem a implementação que os testes novos exigem), lê o
// `.prova/<slug>/resumo.json` que sobrar lá e classifica.
//
// Os quatro desfechos (`lib.ts#classificar`) — só o último reprova:
//   assertion-red   — alguma falha é uma asserção real (não estrutural).
//                     PASS: o teste é vermelho por um motivo de verdade.
//   structural-red  — toda falha é estrutural (import/coleta/tipo — a
//                     base não tem sequer o módulo). PASS SÓ SE o último
//                     commit da PR que tocou os testes for `test(red):`
//                     (worktree-segura §7); senão, FAIL explícito
//                     ("estrutural sem test(red)") — uma falha estrutural
//                     sozinha não distingue "PR rejeitada de propósito" de
//                     "overlay quebrado por acidente".
//   empty-red       — `resumo.json` diz `ok:false` sem nenhuma falha
//                     normalizada (ex.: `{ok:false,total:0,falhas:[]}`).
//                     PASS: `ok` é autoritativo mesmo sem detalhe.
//   vacuous-pass    — a prova passa NA BASE, sem a implementação. FAIL: o
//                     teste não prova nada.
//
// Sem `prova/<slug>.ts` no HEAD → FAIL explícito citando o caminho (PR de
// feature sem prova declarada, issue #42). Base sem `scripts.prova` no
// `package.json` (o harness #42 ainda não existia naquele commit) → PASS
// logado, não há como rodar (`lib.ts#semHarnessNaBase`).
//
// O worktree temporário é sempre removido (`finally`), inclusive quando o
// check reprova ou quando o próprio `git worktree add` falha: `rodarCheck`
// nunca chama `process.exit()` no seu próprio corpo (só retorna um código),
// então o `finally` sempre roda antes do ÚNICO `process.exit()` deste
// módulo, no fim de `main()` (mesma lição de `scripts/prova/run.ts`). Um
// `git worktree add` que falha nunca registrou worktree nenhum — o
// `finally` sabe disso (`registrado`) e só chama `git worktree remove`
// quando há o que remover, sempre limpando o diretório temporário
// (`rmSync`) de qualquer jeito.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { branchSlug } from "../../prova/slug.js";
import type { Resumo } from "../../prova/tipos.js";
import {
  type Args,
  arquivosDeTeste,
  classificar,
  ehCommitTestRed,
  parseArgs,
  semHarnessNaBase,
} from "./lib.js";

function falhaFechada(mensagem: string): never {
  process.stderr.write(`${mensagem}\n`);
  process.exit(1);
}

function falhar(mensagem: string): number {
  process.stderr.write(`${mensagem}\n`);
  return 1;
}

function passar(mensagem: string): number {
  process.stdout.write(`${mensagem}\n`);
  return 0;
}

function escreverSummary(bloco: string): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath === "") return;
  try {
    writeFileSync(summaryPath, `${bloco}\n\n`, { flag: "a" });
  } catch (error) {
    // Sem GITHUB_STEP_SUMMARY gravável não é uma falha do check em si — é
    // só telemetria a menos; nunca vira exit != 0 por conta disso. Mas a
    // causa vai pro stderr — nunca engolida silenciosamente.
    process.stderr.write(
      `controle-negativo: não foi possível escrever em GITHUB_STEP_SUMMARY: ${String(error)}\n`,
    );
  }
}

interface ResultadoGit {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(root: string, args: readonly string[]): ResultadoGit {
  const resultado = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return {
    status: resultado.status ?? 1,
    stdout: resultado.stdout,
    stderr: resultado.stderr,
  };
}

function existeNoCommit(root: string, commit: string, caminhoRelativo: string): boolean {
  return git(root, ["cat-file", "-e", `${commit}:${caminhoRelativo}`]).status === 0;
}

/** `--slug` sobrescreve; senão, deriva da branch atual (git-workflow.md). */
function resolverSlug(root: string, head: string, args: Args): string {
  if (args.slug !== undefined) {
    const caminho = `prova/${args.slug}.ts`;
    if (!existeNoCommit(root, head, caminho)) {
      falhaFechada(`controle-negativo: ${caminho} não existe em ${head} — PR sem prova declarada`);
    }
    return args.slug;
  }

  const branch = git(root, ["branch", "--show-current"]).stdout.trim();
  const slug = branchSlug(branch);
  if (slug === null) {
    falhaFechada(
      `controle-negativo: branch "${branch}" não segue <type>/<n>-<slug>; passe --slug explicitamente`,
    );
  }
  const caminho = `prova/${slug}.ts`;
  if (!existeNoCommit(root, head, caminho)) {
    falhaFechada(`controle-negativo: ${caminho} não existe em ${head} — PR sem prova declarada`);
  }
  return slug;
}

interface ArquivoDiff {
  readonly status: string;
  readonly arquivo: string;
}

function diffNomeStatus(root: string, base: string, head: string): readonly ArquivoDiff[] {
  const resultado = git(root, ["diff", "--no-renames", "--name-status", `${base}...${head}`]);
  if (resultado.status !== 0) {
    falhaFechada(`controle-negativo: git diff ${base}...${head} falhou: ${resultado.stderr}`);
  }
  return resultado.stdout
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
    .map((linha) => {
      const [status, ...resto] = linha.split("\t");
      return { status: status ?? "", arquivo: resto.join("\t") };
    });
}

/** `false` quando `git worktree add` falhou — não há worktree registrado
 * para `git worktree remove` desfazer depois (`rodarCheck`'s `finally`
 * checa isso antes de chamar `worktreeRemove`, senão logaria um "remove
 * falhou" espúrio para um worktree que nunca existiu). Nunca chama
 * `falhaFechada`/`process.exit()` aqui — isso pularia o `finally` de quem
 * chama e vazaria `tmpDir` (o próprio `mkdtempSync`, que já rodou antes
 * desta função).
 */
function worktreeAdd(root: string, tmpDir: string, base: string): boolean {
  const resultado = git(root, ["worktree", "add", "--detach", tmpDir, base]);
  if (resultado.status !== 0) {
    process.stderr.write(`controle-negativo: git worktree add falhou: ${resultado.stderr}\n`);
    return false;
  }
  return true;
}

function worktreeRemove(root: string, tmpDir: string, registrado: boolean): void {
  if (registrado) {
    const resultado = git(root, ["worktree", "remove", "--force", tmpDir]);
    if (resultado.status !== 0) {
      process.stderr.write(
        `controle-negativo: git worktree remove falhou (${resultado.stderr.trim()}); limpando com rmSync mesmo assim\n`,
      );
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

function overlay(
  root: string,
  tmpDir: string,
  head: string,
  arquivos: readonly ArquivoDiff[],
): void {
  for (const { status, arquivo } of arquivos) {
    const destino = join(tmpDir, arquivo);
    if (status === "D") {
      rmSync(destino, { force: true });
      continue;
    }
    const resultado = spawnSync("git", ["show", `${head}:${arquivo}`], {
      cwd: root,
      encoding: "buffer",
    });
    if (resultado.status !== 0) {
      // Nunca silencioso: um A/M do diff que `git show` não consegue ler é
      // uma inconsistência real (objeto ausente, `head` errado) — se
      // ignorado, a base rodaria sem esse arquivo do overlay e o desfecho
      // (`structural-red`/`vacuous-pass`) mentiria sobre o motivo. `throw`
      // aqui propaga através do `finally` de `rodarCheck` (worktree
      // removido) até o `catch` de `main()`, que reporta e sai 1.
      throw new Error(
        `controle-negativo: git show ${head}:${arquivo} falhou: ${resultado.stderr.toString("utf8")}`,
      );
    }
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, resultado.stdout);
  }
}

/** `node_modules` é gitignorado — sem isso, `npm run prova` na base não
 * encontra nem o próprio vitest/tsx. Sem source em `root` (impossível em
 * produção; possível num repositório fake de teste), é um no-op — a
 * ausência de resumo.json depois vira falha explícita, não PASS silencioso. */
function linkNodeModules(root: string, tmpDir: string): void {
  const origem = join(root, "node_modules");
  const destino = join(tmpDir, "node_modules");
  if (!existsSync(origem) || existsSync(destino)) return;
  try {
    symlinkSync(origem, destino, "dir");
  } catch (error) {
    // Ver comentário acima do link — deixa a ausência de resumo.json falar
    // pelo desfecho; a causa do symlink, ainda assim, vai pro stderr.
    process.stderr.write(`controle-negativo: symlink de node_modules falhou: ${String(error)}\n`);
  }
}

function rodarProvaNaBase(tmpDir: string, slug: string): void {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([chave]) => !chave.startsWith("VITEST") && chave !== "LOHRA_PROVA_OUT",
    ),
  );
  spawnSync(npmBin, ["run", "-s", "prova", "--", slug], { cwd: tmpDir, stdio: "inherit", env });
}

function ultimoCommitTocandoTestes(
  root: string,
  base: string,
  head: string,
  testFiles: readonly string[],
): string | null {
  if (testFiles.length === 0) return null;
  const resultado = git(root, ["log", "-1", "--format=%s", `${base}..${head}`, "--", ...testFiles]);
  if (resultado.status !== 0) return null;
  const linha = resultado.stdout.trim();
  return linha.length > 0 ? linha : null;
}

function rodarCheck(
  root: string,
  base: string,
  head: string,
  slug: string,
  overlayFiles: readonly ArquivoDiff[],
  testFiles: readonly string[],
): number {
  const tmpDir = mkdtempSync(join(tmpdir(), "controle-negativo-"));
  let registrado = false;
  try {
    registrado = worktreeAdd(root, tmpDir, base);
    if (!registrado) {
      return falhar(
        `controle-negativo: não foi possível preparar a base ${base} — ver stderr acima`,
      );
    }
    overlay(root, tmpDir, head, overlayFiles);

    const pkgPath = join(tmpDir, "package.json");
    const pkgText = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : "";
    if (semHarnessNaBase(pkgText)) {
      escreverSummary(
        `## controle-negativo\n\nBase \`${base}\` sem \`scripts.prova\` — o harness (#42) ainda ` +
          "não existia naquele commit; PASS logado.",
      );
      return passar("controle-negativo: sem harness na base — PASS logado (não há como rodar)");
    }

    linkNodeModules(root, tmpDir);
    rodarProvaNaBase(tmpDir, slug);

    const resumoRel = `.prova/${slug}/resumo.json`;
    const resumoPath = join(tmpDir, resumoRel);
    if (!existsSync(resumoPath)) {
      return falhar(
        `controle-negativo: base não produziu ${resumoRel} — não foi possível verificar`,
      );
    }
    const resumo = JSON.parse(readFileSync(resumoPath, "utf8")) as Resumo;
    const desfecho = classificar(resumo);

    if (desfecho === "vacuous-pass") {
      escreverSummary(
        `## controle-negativo\n\n**FAILED** — \`vacuous-pass\`: a prova de \`${slug}\` passa na ` +
          `base \`${base}\`, sem a implementação que a PR adiciona.`,
      );
      return falhar(
        `controle-negativo: vacuous-pass — a prova de ${slug} passa na base ${base} sem a implementação`,
      );
    }

    if (desfecho === "structural-red") {
      const subject = ultimoCommitTocandoTestes(root, base, head, testFiles);
      if (subject === null || !ehCommitTestRed(subject)) {
        const citacao = subject === null ? "nenhum commit encontrado" : `"${subject}"`;
        escreverSummary(
          `## controle-negativo\n\n**FAILED** — estrutural sem test(red): o último commit que ` +
            `toca os testes (${citacao}) não é \`test(red):\`.`,
        );
        return falhar(
          `controle-negativo: estrutural sem test(red) — o último commit que toca os testes ` +
            `(${citacao}) precisa ser test(red): para uma falha só estrutural contar como controle ` +
            "negativo válido",
        );
      }
    }

    escreverSummary(`## controle-negativo\n\n\`${desfecho}\` — PASS.`);
    return passar(`controle-negativo: ${desfecho} — PASS`);
  } finally {
    worktreeRemove(root, tmpDir, registrado);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.base === undefined || args.head === undefined) {
    falhaFechada(
      "uso: npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--root <dir>]",
    );
  }
  const root = args.root !== undefined ? resolve(args.root) : process.cwd();
  const base = args.base;
  const head = args.head;

  const slug = resolverSlug(root, head, args);
  const alterados = diffNomeStatus(root, base, head);
  const testFiles = arquivosDeTeste(alterados.map((item) => item.arquivo));
  const overlayFiles = alterados.filter((item) => testFiles.includes(item.arquivo));

  process.exit(rodarCheck(root, base, head, slug, overlayFiles, testFiles));
}

// Só roda `main()` quando este arquivo é o entry point — nunca quando um
// teste importa os símbolos acima diretamente (mesmo padrão de
// `scripts/prova/run.ts`).
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  try {
    main();
  } catch (error) {
    falhaFechada(`controle-negativo: erro inesperado: ${String(error)}`);
  }
}
