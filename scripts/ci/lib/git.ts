// Helper de `git` compartilhado pelos três `run.ts` do CI (escopo,
// contratos, controle-negativo) — issue #62, follow-up das PRs #52/#53/#54.
//
// Dois fail-opens latentes que este arquivo fecha:
//   - `spawnSync(...).error` (ENOENT — binário ausente, PATH quebrado) era
//     descartado em pelo menos um dos três `run.ts`: o processo nunca
//     rodava, `status` virava `null`/`1` e a mensagem de erro ficava sem a
//     causa (invariante 2 do CLAUDE.md — falha nunca silenciosa).
//   - `git diff --name-only` sem `-z` deixa o git decidir sozinho como
//     imprimir um caminho não-ASCII (`core.quotePath`, default `true`):
//     `docs/reference/café.md` sai como `"docs/reference/caf\303\251.md"` —
//     uma string que não bate com o caminho real, então uma regra de
//     contrato ou de escopo nunca vê esse arquivo. `-z` sempre imprime bytes
//     crus, terminados em NUL, nunca quotados.
import { spawnSync } from "node:child_process";

/** Execução de `git` em modo texto (utf8) — o shape comum aos três
 * `run.ts`. `error`/`signal` nunca descartados: são o que `causaGit`
 * precisa para nunca reportar um "falhou" genérico. */
export interface ExecucaoGit {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

/** Mesmo shape, mas com `stdout`/`stderr` em `Buffer` — para `git show` de
 * conteúdo binário/arbitrário (overlay do `controle-negativo`). */
export interface ExecucaoGitBinaria {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

// `SpawnSyncReturns<string>.stdout`/`.stderr` são tipados como sempre
// `string` (nunca `| undefined`) em `@types/node`, mas na prática, quando o
// processo nem chega a rodar (ENOENT — binário ausente), o Node devolve
// `undefined` de verdade nesses dois campos. `??` abaixo cobre esse caso
// real que o tipo declarado esconde; o cast é o que torna o fallback
// necessário aos olhos do `no-unnecessary-condition`, que só vê o tipo
// declarado.
function textoOuVazio(valor: string | undefined): string {
  return valor ?? "";
}

function bufferOuVazio(valor: Buffer | undefined): Buffer {
  return valor ?? Buffer.alloc(0);
}

/** Roda `git <args>` em `cwd`, em modo texto. `env`, quando passado,
 * substitui o environment do processo filho por inteiro (usado pelos testes
 * de ENOENT — `PATH` vazio); por padrão herda `process.env`. */
export function git(
  root: string,
  args: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): ExecucaoGit {
  const resultado = spawnSync("git", args as string[], {
    cwd: root,
    encoding: "utf8",
    ...(env !== undefined ? { env: env } : {}),
  });
  return {
    status: resultado.status ?? 1,
    stdout: textoOuVazio(resultado.stdout),
    stderr: textoOuVazio(resultado.stderr),
    signal: resultado.signal,
    ...(resultado.error !== undefined ? { error: resultado.error } : {}),
  };
}

/** Mesma execução, mas em modo binário (`git show <ref>:<arquivo>` de um
 * arquivo que pode não ser texto). */
export function gitBinario(root: string, args: readonly string[]): ExecucaoGitBinaria {
  const resultado = spawnSync("git", args as string[], { cwd: root, encoding: "buffer" });
  return {
    status: resultado.status ?? 1,
    stdout: bufferOuVazio(resultado.stdout),
    stderr: bufferOuVazio(resultado.stderr),
    signal: resultado.signal,
    ...(resultado.error !== undefined ? { error: resultado.error } : {}),
  };
}

/** `true` quando a execução rodou de verdade e saiu 0 — nunca confunde
 * "não achei nada" (status 0, stdout vazio) com "o processo nem rodou"
 * (error definido, status irrelevante). */
function ehSucesso(execucao: Pick<ExecucaoGit, "error" | "status">): boolean {
  return execucao.error === undefined && execucao.status === 0;
}

/** Mensagem de causa fail-closed: nunca "falhou" sozinho. Junta, na ordem,
 * o motivo do spawn (ENOENT etc.), o sinal (se o processo foi morto), o
 * exit code, e o stderr do próprio `git` quando houver — o invariante 2 do
 * CLAUDE.md (causa nunca perdida) aplicado à execução de um processo. */
export function causaGit(
  execucao: Pick<ExecucaoGit, "error" | "status" | "signal" | "stderr">,
): string {
  const partes: string[] = [];
  if (execucao.error !== undefined) partes.push(`spawn: ${execucao.error.message}`);
  if (execucao.signal !== null) partes.push(`sinal ${execucao.signal}`);
  partes.push(`exit code ${String(execucao.status)}`);
  const stderrTexto =
    typeof execucao.stderr === "string"
      ? execucao.stderr
      : Buffer.from(execucao.stderr).toString("utf8");
  const stderrAparado = stderrTexto.trim();
  if (stderrAparado !== "") partes.push(stderrAparado);
  return partes.join(" — ");
}

function dividirPorNul(saida: string): readonly string[] {
  return saida.split("\0").filter((parte) => parte.length > 0);
}

/**
 * `git diff --no-renames --name-only -z base...head`, decodificado a partir
 * de NUL — nunca quebra num caminho com acento, espaço ou aspas (`-z`
 * sempre imprime bytes crus, ignorando `core.quotePath`). Lança citando a
 * causa completa (spawn/exit/sinal/stderr) quando o comando falha — quem
 * chama nunca vê um "git diff falhou" sem contexto.
 */
export function gitDiffNames(root: string, base: string, head: string): readonly string[] {
  const execucao = git(root, ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`]);
  if (!ehSucesso(execucao)) {
    throw new Error(`git diff --name-only ${base}...${head} falhou: ${causaGit(execucao)}`);
  }
  return dividirPorNul(execucao.stdout);
}

export interface ArquivoDiff {
  readonly status: string;
  readonly arquivo: string;
}

/** Mesma robustez de `gitDiffNames`, mas com o status de cada arquivo
 * (`--name-status`) — usado pelo `controle-negativo` para distinguir "D" de
 * "A"/"M" no overlay. `-z` produz pares `STATUS\0ARQUIVO\0...`. */
export function gitDiffNameStatus(
  root: string,
  base: string,
  head: string,
): readonly ArquivoDiff[] {
  const execucao = git(root, ["diff", "--no-renames", "--name-status", "-z", `${base}...${head}`]);
  if (!ehSucesso(execucao)) {
    throw new Error(`git diff --name-status ${base}...${head} falhou: ${causaGit(execucao)}`);
  }
  const campos = dividirPorNul(execucao.stdout);
  const indices = Array.from({ length: Math.floor(campos.length / 2) }, (_, i) => i * 2);
  return indices
    .map((i) => ({ status: campos[i], arquivo: campos[i + 1] }))
    .filter(
      (par): par is ArquivoDiff =>
        typeof par.status === "string" && typeof par.arquivo === "string",
    );
}
