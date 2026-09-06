#!/usr/bin/env node
// `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>]
// [--branch <ref>] [--root <dir>]` (issue #48, rodada 2 da PR #54) — prova
// que os testes novos de uma PR reprovam contra a base da PR, para que
// "teste primeiro" seja verificado por máquina, não só prometido no commit.
//
// SKIP por classe (ADR 0004 item 7, `lib.ts:114-160`) — três casos, todos
// exit 0 ANTES de sequer resolver o slug:
//   - classes `docs`/`process`: TODO o diff cai em `docs/**`, `README.md`,
//     `CLAUDE.md`, `AGENTS.md`, `.worktreeinclude`, `.claude/**`,
//     `.github/**` ou `scripts/github/**` (`lib.ts#ehArquivoDocsOuProcess`/
//     `#deveSerIgnorado`). Diff vazio NÃO conta como SKIP (ver o comentário
//     de `deveSerIgnorado`).
//   - só declaração de prova já existente editada: tirando as classes
//     acima, tudo que sobra no diff é `prova/<slug>.ts` que já existia na
//     base — nenhum `tests/**`/`src/**`/`scripts/**` de comportamento novo
//     entrou (`lib.ts#soDeclaracaoDeProvaExistenteEditada`).
//   - diff inteiro cai no overlay (issue #114, bloqueava a PR #113; lacunas
//     1 e 2 fechadas na #117): tirando as classes acima, tudo que sobra é
//     `tests/**`+`prova/**` (fixtures contam nesse "tudo" — `ehArquivoDoOverlay`
//     usa a `TESTES_PREFIXO_RE` mais larga), com pelo menos um
//     `tests/**\/*.test.ts` especificamente (nunca uma fixture — aí sim
//     `TESTE_RE`) que já existia na base (EDITADO, não criado, não deletado
//     no head) — o overlay do HEAD sobre a base reproduz o próprio HEAD
//     (base+overlay ≡ head) e o desfecho é sempre `vacuous-pass`, mesmo com
//     um `test(red):` real — `lib.ts#soArquivosDoOverlay`.
//
// Um `tests/**` inteiramente NOVO (sem nenhum já editado) não entra no SKIP
// acima — não é um quarto pré-check estático, é um desvio dentro da
// mecânica normal: um pré-check pelo formato do diff sozinho não distingue
// "vacuous-pass por construção" (issue #117, lacuna 3 — sem `src/**`, o
// mecanismo nunca teria como discriminar) de um `structural-red` legítimo
// que ainda precisa do commit `test(red):` COM stub (`repoStructuralRed
// ("sem-stub")` — um `test(red):` sem stub continua reprovado). O gate fica
// só no branch de `vacuous-pass`, abaixo: só ali sabemos de verdade que o
// mecanismo (não um palpite sobre o diff) não discriminou.
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
//                     teste não prova nada — EXCETO (issue #117, lacuna 3)
//                     quando o diff é overlay-only sem nenhum `tests/**`
//                     editado (teste inteiramente novo, sem produção): aí
//                     PASS logado como SKIP quando existe um commit
//                     `test(red):` que toca os testes do diff (controle
//                     manual pelo revisor), FAIL citando a exigência quando
//                     não existe.
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
  causaGit,
  git,
  gitBinario,
  gitDiffNameStatus,
  type ArquivoDiff,
  type ExecucaoGit,
} from "../lib/git.js";
import { appendSummary } from "../lib/summary.js";
import {
  type Args,
  arquivosDeTeste,
  classificar,
  contemStubQueLanca,
  deveSerIgnorado,
  ehCommitTestRed,
  ehDiffSoDoOverlay,
  parseArgs,
  semHarnessNaBase,
  soArquivosDoOverlay,
  soDeclaracaoDeProvaExistenteEditada,
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

/** Delega a escrita para `appendSummary` (`../lib/summary.js`, issue #78) —
 * nunca lança, nunca faz este check reagir diferente de `contratos` a um
 * `GITHUB_STEP_SUMMARY` não gravável. A linha em branco extra mantém os
 * blocos do job summary separados (mesmo espaçamento de antes da
 * unificação, quando este arquivo escrevia `${bloco}\n\n` diretamente). */
function escreverSummary(bloco: string): void {
  appendSummary(`${bloco}\n`);
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

/** `git diff --name-status -z` via `../lib/git.js` (issue #62): nunca
 * escapa um caminho não-ASCII, e a causa (ENOENT, sinal, exit code, stderr)
 * nunca é perdida quando o comando falha. */
function diffNomeStatus(root: string, base: string, head: string): readonly ArquivoDiff[] {
  try {
    return gitDiffNameStatus(root, base, head);
  } catch (erro) {
    falhaFechada(`controle-negativo: ${erro instanceof Error ? erro.message : String(erro)}`);
  }
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
  if (resultado.error !== undefined || resultado.status !== 0) {
    process.stderr.write(`controle-negativo: git worktree add falhou: ${causaGit(resultado)}\n`);
    return false;
  }
  return true;
}

function worktreeRemove(root: string, tmpDir: string, registrado: boolean): void {
  if (registrado) {
    const resultado = git(root, ["worktree", "remove", "--force", tmpDir]);
    if (resultado.error !== undefined || resultado.status !== 0) {
      process.stderr.write(
        `controle-negativo: git worktree remove falhou (${causaGit(resultado)}); limpando com rmSync mesmo assim\n`,
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
      const stderrTexto = resultado.stderr.toString("utf8").trim();
      throw new Error(
        `controle-negativo: git show ${head}:${arquivo} falhou: exit code ${String(resultado.status)}` +
          (stderrTexto === "" ? "" : ` — ${stderrTexto}`),
      );
    }
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, resultado.stdout);
  }
}

function mostrarArquivoGit(root: string, head: string, arquivo: string): MostrarArquivo {
  return gitBinario(root, ["show", `${head}:${arquivo}`]);
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

/** Tempo máximo para `npm run prova -- <slug>` rodar NA BASE — issue #62: sem
 * isso, um harness travado (loop infinito, processo pendurado) nunca
 * devolve o controle ao check, que fica pendurado indefinidamente no CI.
 * 10 minutos: generoso o bastante para a suíte inteira de uma issue grande,
 * curto o bastante para não esconder um job travado por horas. */
export const TIMEOUT_PROVA_MS = 10 * 60 * 1000;

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
    timeout: TIMEOUT_PROVA_MS,
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

/** Shape mínimo que `commitsQueTocamTestes`/`commitAdicionaStub` precisam de
 * uma execução de `git` — permite injetar um fake nos testes unitários
 * (mesmo espírito de `overlay`/`mostrarArquivo`), sem exigir `signal`/
 * `error` de quem só quer simular `status`/`stdout`/`stderr`. */
export type ResultadoGitMinimo = Pick<ExecucaoGit, "status" | "stdout" | "stderr">;

function causaGitMinima(resultado: ResultadoGitMinimo): string {
  return causaGit({ ...resultado, signal: null });
}

/** `git log --format=%H%x01%s base..head -- <testFiles>`, exportado para
 * teste unitário com a execução do `git` injetada. Issue #62: um `git log`
 * que falha de verdade (revisão inválida, repositório corrompido) antes só
 * virava `[]` silenciosamente — indistinguível de "nenhum commit toca os
 * testes". Agora lança, citando a causa completa; nunca um `structural-red`
 * reprovado por engano por um problema de infraestrutura. */
export function commitsQueTocamTestes(
  executarGit: (args: readonly string[]) => ResultadoGitMinimo,
  base: string,
  head: string,
  testFiles: readonly string[],
): readonly CommitInfo[] {
  if (testFiles.length === 0) return [];
  const resultado = executarGit([
    "log",
    "--format=%H%x01%s",
    `${base}..${head}`,
    "--",
    ...testFiles,
  ]);
  if (resultado.status !== 0) {
    throw new Error(
      `controle-negativo: git log ${base}..${head} falhou: ${causaGitMinima(resultado)}`,
    );
  }
  return resultado.stdout
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
    .map((linha) => {
      const [sha, subject] = linha.split("\x01");
      return { sha: sha ?? "", subject: subject ?? "" };
    });
}

/** `git show <sha> -- <arquivosNaoTeste>`, exportado para teste unitário com
 * a execução do `git` injetada — mesma razão de `commitsQueTocamTestes`:
 * uma falha real de `git show` nunca pode virar `false` silencioso. */
export function commitAdicionaStub(
  executarGit: (args: readonly string[]) => ResultadoGitMinimo,
  sha: string,
  arquivosNaoTeste: readonly string[],
): boolean {
  if (arquivosNaoTeste.length === 0) return false;
  const resultado = executarGit(["show", sha, "--", ...arquivosNaoTeste]);
  if (resultado.status !== 0) {
    throw new Error(`controle-negativo: git show ${sha} falhou: ${causaGitMinima(resultado)}`);
  }
  return contemStubQueLanca(resultado.stdout);
}

/** `structural-red` só é um controle negativo válido quando pelo menos um
 * commit `test(red):` no range também adiciona o stub que lança em algum
 * arquivo NÃO-teste — ver o cabeçalho deste arquivo e `lib.ts`. */
function existeTestRedValido(
  root: string,
  base: string,
  head: string,
  testFiles: readonly string[],
  arquivosNaoTeste: readonly string[],
): boolean {
  const executarGit = (args: readonly string[]): ResultadoGitMinimo => git(root, args);
  return commitsQueTocamTestes(executarGit, base, head, testFiles).some(
    (commit) =>
      ehCommitTestRed(commit.subject) &&
      commitAdicionaStub(executarGit, commit.sha, arquivosNaoTeste),
  );
}

function rodarCheck(
  root: string,
  base: string,
  head: string,
  slug: string,
  overlayFiles: readonly ArquivoDiff[],
  testFiles: readonly string[],
  arquivosNaoTeste: readonly string[],
  ehOverlayOnly: boolean,
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
      // Issue #117 (lacuna 3, Contexto item 3 da issue #114): diff
      // overlay-only sem nenhum `tests/**` editado (`ehOverlayOnly` só é
      // `true` aqui porque `soArquivosDoOverlay` já foi `false` em
      // `main()`) — teste inteiramente novo, sem produção. base+overlay ≡
      // head faz vacuous-pass acontecer POR CONSTRUÇÃO, mesmo com um
      // `test(red):` real (não há src/** para o mecanismo discriminar). Em
      // vez de reprovar sempre, aceita um commit `test(red):` que toque os
      // testes do diff como controle manual — mesmo critério de commit que
      // `existeTestRedValido` usa para `structural-red`, sem o requisito do
      // stub (não há arquivo de produção para carregar um).
      //
      // Gated no desfecho de VERDADE (não um pré-check em `main()`, ao
      // contrário dos outros dois SKIPs): um pré-check estático no formato
      // do diff apanharia também `repoStructuralRed("sem-stub")` — um
      // commit `test(red):` sem stub, que a checagem de `structural-red`
      // abaixo corretamente reprova — e faria SKIP nela, fail-open real.
      if (ehOverlayOnly) {
        const executarGit = (args: readonly string[]): ResultadoGitMinimo => git(root, args);
        const commitRed = commitsQueTocamTestes(executarGit, base, head, testFiles).find((commit) =>
          ehCommitTestRed(commit.subject),
        );
        if (commitRed !== undefined) {
          const motivo =
            `SKIP — teste novo sem produção: vacuous-pass na base, controle manual pelo commit ` +
            `test(red): ${commitRed.sha}`;
          escreverSummary(`## controle-negativo\n\n${motivo}`);
          return passar(`controle-negativo: ${motivo}`);
        }
        escreverSummary(
          `## controle-negativo\n\n**FAILED** — \`vacuous-pass\`: a prova de \`${slug}\` passa na ` +
            `base \`${base}\` — teste novo sem produção e sem nenhum commit \`test(red):\` em ` +
            `\`${base}..${head}\` que toque os testes do diff.`,
        );
        return falhar(
          `controle-negativo: vacuous-pass — a prova de ${slug} passa na base ${base} sem a ` +
            `implementação, e sem commit test(red): em ${base}..${head} que toque os testes do diff`,
        );
      }
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
  const arquivosAlterados = alterados.map((item) => item.arquivo);
  if (deveSerIgnorado(arquivosAlterados)) {
    escreverSummary("## controle-negativo\n\nSKIP — PR de classe docs/process, nada a controlar.");
    process.stdout.write("controle-negativo: SKIP — PR de classe docs/process, nada a controlar\n");
    process.exit(0);
  }

  // Acréscimo à issue #62 (bloqueava a #65): só uma declaração de prova
  // (`prova/<slug>.ts`) JÁ EXISTENTE na base foi tocada — nenhum
  // `tests/**`/`src/**`/`scripts/**` de verdade no diff, então não há
  // comportamento novo para provar vermelho. `prova/<slug>.ts` ausente na
  // base (declaração nova) NÃO entra aqui — continua exigindo controle.
  if (
    soDeclaracaoDeProvaExistenteEditada(arquivosAlterados, (arquivo) =>
      existeNoCommit(root, base, arquivo),
    )
  ) {
    escreverSummary(
      "## controle-negativo\n\nSKIP — só declaração de prova existente editada, nada a controlar.",
    );
    process.stdout.write(
      "controle-negativo: SKIP — só declaração de prova existente editada, nada a controlar\n",
    );
    process.exit(0);
  }

  // `statusPorArquivo`/`statusNoDiff`: já temos o status (`A`/`M`/`D`) de
  // cada arquivo do `git diff --name-status` (`alterados`) — zero I/O novo,
  // só reaproveitar o que `diffNomeStatus` já leu. Issue #117 (lacuna 2):
  // um arquivo deletado existe na base por definição, mas nunca existiu no
  // head — sem excluir `status === "D"`, uma PR que só apaga um `tests/**`
  // virava SKIP indevido.
  const statusPorArquivo = new Map(alterados.map((item) => [item.arquivo, item.status]));
  const statusNoDiff = (arquivo: string): string => statusPorArquivo.get(arquivo) ?? "M";
  const arquivoJaExisteNaBase = (arquivo: string): boolean => existeNoCommit(root, base, arquivo);

  // Issue #114 (bloqueava a PR #113): diff inteiro dentro do overlay
  // (`tests/**`+`prova/**`, com pelo menos um `tests/**` JÁ EXISTENTE na
  // base, editado, não deletado) — base+overlay ≡ head, o mecanismo abaixo
  // nunca consegue discriminar vermelho de verde. Motivo explícito e
  // distinto dos outros dois SKIPs: o revisor confere o commit `test(red):`
  // manualmente.
  if (soArquivosDoOverlay(arquivosAlterados, arquivoJaExisteNaBase, statusNoDiff)) {
    const motivo =
      "SKIP — diff só de tests/**+prova/**: base+overlay ≡ head, o controle não discrimina; " +
      "o revisor confere o commit test(red):";
    escreverSummary(`## controle-negativo\n\n${motivo}`);
    process.stdout.write(`controle-negativo: ${motivo}\n`);
    process.exit(0);
  }

  // Issue #117 (lacuna 3): diff overlay-only mas SEM nenhum `tests/**`
  // editado (a condição acima já foi `false`) — teste inteiramente novo,
  // sem produção. NÃO é um SKIP antecipado como os três acima: o mecanismo
  // roda normalmente (`rodarCheck` recebe `ehOverlayOnly` e só abre a
  // exceção quando o desfecho de verdade é `vacuous-pass` — ver o
  // cabeçalho do arquivo e o comentário de `ehDiffSoDoOverlay`, `lib.ts`).
  const ehOverlayOnly = ehDiffSoDoOverlay(arquivosAlterados);

  const slug = resolverSlug(root, head, args);
  const testFiles = arquivosDeTeste(alterados.map((item) => item.arquivo));
  const overlayFiles = alterados.filter((item) => testFiles.includes(item.arquivo));
  const arquivosNaoTeste = alterados
    .filter((item) => !testFiles.includes(item.arquivo))
    .map((item) => item.arquivo);

  process.exit(
    rodarCheck(root, base, head, slug, overlayFiles, testFiles, arquivosNaoTeste, ehOverlayOnly),
  );
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
