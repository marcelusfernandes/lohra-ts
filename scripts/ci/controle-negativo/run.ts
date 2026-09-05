#!/usr/bin/env node
// `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>]
// [--branch <ref>] [--root <dir>]` (issue #48, rodada 2 da PR #54) — prova
// que os testes novos de uma PR reprovam contra a base da PR, para que
// "teste primeiro" seja verificado por máquina, não só prometido no commit.
//
// SKIP por classe (ADR 0004 item 7): se TODO o diff cai em `docs/**`,
// `README.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/**` ou `.github/**` —
// classes `docs`/`process` — não há o que controlar: SKIP, exit 0, antes
// de sequer resolver o slug (`lib.ts#deveSerIgnorado`). Diff vazio NÃO
// conta como SKIP (ver o comentário de `deveSerIgnorado`).
//
// Mecânica (fora do caso SKIP): `git worktree add --detach <tmp> <base>`,
// overlay só dos arquivos de teste do diff (`tests/**/*.test.ts`,
// `prova/**` — `lib.ts#arquivosDeTeste`) copiados do HEAD por cima da
// base, roda `npm run -s prova -- <slug>` NA BASE (o próprio código de
// produção da base, sem a implementação que os testes novos exigem), lê o
// `.prova/<slug>/resumo.json` que sobrar lá — validado (`lib.ts#validarResumo`)
// antes de confiar no shape — e classifica.
//
// Os quatro desfechos (`lib.ts#classificar`) — só o último reprova:
//   assertion-red   — alguma falha é uma asserção real (não estrutural).
//                     PASS: o teste é vermelho por um motivo de verdade.
//   structural-red  — toda falha é estrutural (import/coleta/tipo — a
//                     base não tem sequer o módulo). PASS quando existe
//                     PELO MENOS UM commit `test(red):` em `base..head`
//                     que toca os arquivos de teste do diff E adiciona,
//                     no MESMO commit, um stub que lança em algum arquivo
//                     NÃO-teste do diff (`throw new Error(` — convenção
//                     `worktree-segura` §7; mesma checagem do
//                     `hasDeclaredThrowingStub` do Apollo). Rodada 2 da PR
//                     #54: a regra anterior exigia isso do ÚLTIMO commit
//                     que toca os testes, o que reprovava toda PR TDD
//                     normal (commit a cada verde depois do vermelho) —
//                     reproduzido contra a própria PR #54 e a #52 já
//                     mergeada. Sem candidato válido → FAIL explícito
//                     ("estrutural sem test(red) válido").
//   empty-red       — `resumo.json` diz `ok:false` sem nenhuma falha
//                     normalizada (ex.: `{ok:false,total:0,falhas:[]}`).
//                     PASS: `ok` é autoritativo mesmo sem detalhe.
//   vacuous-pass    — a prova passa NA BASE, sem a implementação. FAIL: o
//                     teste não prova nada.
//
// Sem `prova/<slug>.ts` no HEAD → FAIL explícito citando o caminho (PR de
// feature sem prova declarada, issue #42) — fora do caso SKIP acima. Base
// sem `package.json` (arquivo ausente) ou com `package.json` sem
// `scripts.prova` (o harness #42 ainda não existia naquele commit) → PASS
// logado, não há como rodar (`lib.ts#semHarnessNaBase`). Base com
// `package.json` PRESENTE mas ILEGÍVEL (JSON inválido) é DIFERENTE — isso
// é uma falha real, não "sem harness": FAIL explícito citando o caminho,
// nunca um PASS silencioso.
//
// `--branch <ref>`: no CI o checkout do HEAD é detached (sem branch local
// para `git branch --show-current` resolver), então o job passa
// `--branch "$GITHUB_HEAD_REF"` e o slug é resolvido a partir dela (mesma
// convenção de `scripts/prova/slug.ts`) — `--slug` sobrescreve quando
// presente.
//
// `linkNodeModules` roda a base com o `node_modules` do HEAD (symlink) —
// limite declarado: o que este check prova é que o TESTE reprova contra o
// CÓDIGO da base, não que o ambiente de instalação daquele commit seja
// reproduzido byte a byte; se o harness da base precisasse de uma versão
// diferente de alguma dependência, isso não é modelado aqui.
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
import {
  type Args,
  arquivosDeTeste,
  classificar,
  contemStubQueLanca,
  deveSerIgnorado,
  ehCommitTestRed,
  parseArgs,
  semHarnessNaBase,
  validarResumo,
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

/** `--slug` sobrescreve; senão, deriva de `--branch` (checkout detached do
 * CI) ou, na falta dele, da branch atual local (git-workflow.md). */
function resolverSlug(root: string, head: string, args: Args): string {
  if (args.slug !== undefined) {
    const caminho = `prova/${args.slug}.ts`;
    if (!existeNoCommit(root, head, caminho)) {
      falhaFechada(`controle-negativo: ${caminho} não existe em ${head} — PR sem prova declarada`);
    }
    return args.slug;
  }

  const branch = args.branch ?? git(root, ["branch", "--show-current"]).stdout.trim();
  const slug = branchSlug(branch);
  if (slug === null) {
    falhaFechada(
      `controle-negativo: branch "${branch}" não segue <type>/<n>-<slug>; passe --slug ou --branch explicitamente`,
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

/** Resultado de "mostrar" um arquivo em um commit — abstrai `git show
 * <ref>:<arquivo>` para que `overlay` seja testável sem git de verdade
 * (injeção de dependência, não um mock de módulo). */
interface MostrarArquivo {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/**
 * Aplica o overlay: para "D", remove o arquivo do worktree (nunca chama
 * `mostrarArquivo`); para "A"/"M", pede o conteúdo em `head` via
 * `mostrarArquivo` e escreve. `mostrarArquivo` que falha para um A/M do
 * diff é uma inconsistência real (objeto ausente, `head` errado) — nunca
 * silencioso: um overlay incompleto mentiria sobre o motivo do desfecho.
 * `throw` aqui propaga através do `finally` de `rodarCheck` (worktree
 * removido) até o `catch` de `main()`, que reporta e sai 1.
 */
export function overlay(
  tmpDir: string,
  head: string,
  arquivos: readonly ArquivoDiff[],
  mostrarArquivo: (arquivo: string) => MostrarArquivo,
): void {
  for (const { status, arquivo } of arquivos) {
    const destino = join(tmpDir, arquivo);
    if (status === "D") {
      rmSync(destino, { force: true });
      continue;
    }
    const resultado = mostrarArquivo(arquivo);
    if (resultado.status !== 0) {
      throw new Error(
        `controle-negativo: git show ${head}:${arquivo} falhou: ${resultado.stderr.toString("utf8")}`,
      );
    }
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, resultado.stdout);
  }
}

function mostrarArquivoGit(root: string, head: string, arquivo: string): MostrarArquivo {
  const resultado = spawnSync("git", ["show", `${head}:${arquivo}`], {
    cwd: root,
    encoding: "buffer",
  });
  return { status: resultado.status ?? 1, stdout: resultado.stdout, stderr: resultado.stderr };
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

interface ExecucaoProva {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

function rodarProvaNaBase(tmpDir: string, slug: string): ExecucaoProva {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([chave]) => !chave.startsWith("VITEST") && chave !== "LOHRA_PROVA_OUT",
    ),
  );
  const resultado = spawnSync(npmBin, ["run", "-s", "prova", "--", slug], {
    cwd: tmpDir,
    stdio: "inherit",
    env,
  });
  return {
    status: resultado.status,
    signal: resultado.signal,
    ...(resultado.error !== undefined ? { error: resultado.error } : {}),
  };
}

function causaExecucao(execucao: ExecucaoProva): string {
  if (execucao.error !== undefined) return execucao.error.message;
  if (execucao.signal !== null) return `encerrado pelo sinal ${execucao.signal}`;
  return `exit code ${String(execucao.status)}`;
}

interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
}

function commitsQueTocamTestes(
  root: string,
  base: string,
  head: string,
  testFiles: readonly string[],
): readonly CommitInfo[] {
  if (testFiles.length === 0) return [];
  const resultado = git(root, ["log", "--format=%H%x01%s", `${base}..${head}`, "--", ...testFiles]);
  if (resultado.status !== 0) return [];
  return resultado.stdout
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
    .map((linha) => {
      const [sha, subject] = linha.split("\x01");
      return { sha: sha ?? "", subject: subject ?? "" };
    });
}

function commitAdicionaStub(
  root: string,
  sha: string,
  arquivosNaoTeste: readonly string[],
): boolean {
  if (arquivosNaoTeste.length === 0) return false;
  const resultado = git(root, ["show", sha, "--", ...arquivosNaoTeste]);
  if (resultado.status !== 0) return false;
  return contemStubQueLanca(resultado.stdout);
}

/** `structural-red` só é um controle negativo válido quando pelo menos um
 * commit `test(red):` no range também adiciona o stub que lança em algum
 * arquivo NÃO-teste — ver o cabeçalho deste arquivo e `lib.ts`. */
function existeTestRedValido(
  _root: string,
  _base: string,
  _head: string,
  _testFiles: readonly string[],
  _arquivosNaoTeste: readonly string[],
): boolean {
  void commitsQueTocamTestes;
  void commitAdicionaStub;
  void ehCommitTestRed;
  throw new Error("not implemented: existeTestRedValido");
}

function rodarCheck(
  root: string,
  base: string,
  head: string,
  slug: string,
  overlayFiles: readonly ArquivoDiff[],
  testFiles: readonly string[],
  arquivosNaoTeste: readonly string[],
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
    overlay(tmpDir, head, overlayFiles, (arquivo) => mostrarArquivoGit(root, head, arquivo));

    const pkgPath = join(tmpDir, "package.json");
    if (!existsSync(pkgPath)) {
      escreverSummary(
        `## controle-negativo\n\nBase \`${base}\` sem \`package.json\` — o harness (#42) ainda não ` +
          "existia naquele commit; PASS logado.",
      );
      return passar("controle-negativo: sem harness na base (sem package.json) — PASS logado");
    }
    const pkgText = readFileSync(pkgPath, "utf8");
    let semHarness: boolean;
    try {
      semHarness = semHarnessNaBase(pkgText);
    } catch (erro) {
      // Diferente de "arquivo ausente" acima: aqui o package.json EXISTE
      // mas é JSON inválido — uma falha real da base, não "sem harness".
      return falhar(
        `controle-negativo: package.json da base ${base} é JSON inválido — não foi possível ` +
          `verificar scripts.prova (${String(erro)})`,
      );
    }
    if (semHarness) {
      escreverSummary(
        `## controle-negativo\n\nBase \`${base}\` sem \`scripts.prova\` — o harness (#42) ainda ` +
          "não existia naquele commit; PASS logado.",
      );
      return passar("controle-negativo: sem harness na base — PASS logado (não há como rodar)");
    }

    linkNodeModules(root, tmpDir);
    const execucao = rodarProvaNaBase(tmpDir, slug);

    const resumoRel = `.prova/${slug}/resumo.json`;
    const resumoPath = join(tmpDir, resumoRel);
    if (!existsSync(resumoPath)) {
      return falhar(
        `controle-negativo: base não produziu ${resumoRel} — não foi possível verificar ` +
          `(${causaExecucao(execucao)})`,
      );
    }
    const resumoBruto: unknown = JSON.parse(readFileSync(resumoPath, "utf8"));
    const resumo = validarResumo(resumoBruto, resumoRel);
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

    if (
      desfecho === "structural-red" &&
      !existeTestRedValido(root, base, head, testFiles, arquivosNaoTeste)
    ) {
      escreverSummary(
        `## controle-negativo\n\n**FAILED** — estrutural sem test(red) válido: nenhum commit ` +
          `\`test(red):\` em \`${base}..${head}\` que toca os testes do diff e adiciona um stub que ` +
          "lança (`throw new Error(`) num arquivo não-teste.",
      );
      return falhar(
        `controle-negativo: estrutural sem test(red) válido — nenhum commit test(red): em ` +
          `${base}..${head} que toca os testes do diff e adiciona um stub que lança (throw new ` +
          "Error() em arquivo não-teste, worktree-segura §7)",
      );
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
      "uso: npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--branch <ref>] [--root <dir>]",
    );
  }
  const root = args.root !== undefined ? resolve(args.root) : process.cwd();
  const base = args.base;
  const head = args.head;

  const alterados = diffNomeStatus(root, base, head);
  if (deveSerIgnorado(alterados.map((item) => item.arquivo))) {
    escreverSummary("## controle-negativo\n\nSKIP — PR de classe docs/process, nada a controlar.");
    process.stdout.write("controle-negativo: SKIP — PR de classe docs/process, nada a controlar\n");
    process.exit(0);
  }

  const slug = resolverSlug(root, head, args);
  const testFiles = arquivosDeTeste(alterados.map((item) => item.arquivo));
  const overlayFiles = alterados.filter((item) => testFiles.includes(item.arquivo));
  const arquivosNaoTeste = alterados
    .filter((item) => !testFiles.includes(item.arquivo))
    .map((item) => item.arquivo);

  process.exit(rodarCheck(root, base, head, slug, overlayFiles, testFiles, arquivosNaoTeste));
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
