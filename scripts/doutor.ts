#!/usr/bin/env node
// `npm run doutor` (issue #63): confere se esta máquina tem o que o
// lohra-ts precisa para desenvolver — Node, toolchain nativo do node-pty em
// Linux, `gh` autenticado, e os dois hooks locais (`git-pre-push`, camada 2
// da proteção da main; `lefthook` pre-commit) — e diz o comando que resolve
// cada falta. Nunca instala nada sozinho: só diagnostica.
//
// Cada checagem que fala com o sistema operacional recebe um `Executor`
// injetável (mesmo padrão de `scripts/ci/lib/git.ts`) — os testes trocam a
// execução real por um duplo, sem depender do PATH desta máquina (issue #63,
// AC "testes unitários com exec injetado").
//
// STUB (test(red), issue #63): as checagens lançam "not implemented"; a
// implementação real vem no commit seguinte.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Resultado de rodar um comando — nunca descarta `error` (ENOENT etc.),
 * mesmo padrão de `ExecucaoGit` em `scripts/ci/lib/git.ts`. */
export interface ResultadoExec {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type Executor = (cmd: string, args: readonly string[]) => ResultadoExec;

export type StatusChecagem = "ok" | "falta";

export interface Checagem {
  readonly nome: string;
  readonly status: StatusChecagem;
  readonly detalhe: string;
  /** Só presente quando `status === "falta"` — o comando que resolve. */
  readonly comando?: string;
}

/** `Executor` de verdade — só usado por `main()`; os testes nunca importam
 * este símbolo, sempre injetam um duplo nas checagens. */
export const executorReal: Executor = (_cmd, _args) => {
  throw new Error("not implemented");
};

/** Node >= 20 (`engines.node` do `package.json`). */
export function checarNode(_versao: string = process.version): Checagem {
  throw new Error("not implemented");
}

/** `python3`/`make`/`g++` — só exigidos em Linux (build nativo do node-pty;
 * macOS usa o Xcode Command Line Tools, Windows não builda na instalação). */
export function checarToolchainNativo(_plataforma: NodeJS.Platform, _exec: Executor): Checagem {
  throw new Error("not implemented");
}

/** `gh auth status` — binário ausente e binário presente mas deslogado são
 * duas causas de "falta" distintas, cada uma com o comando certo. */
export function checarGh(_exec: Executor): Checagem {
  throw new Error("not implemented");
}

/** `git-pre-push` (camada 2 da proteção da main) instalado no hooks dir
 * deste checkout — `git rev-parse --git-path hooks` resolve certo mesmo de
 * dentro de um worktree (hooks dir é o do checkout principal, compartilhado). */
export function checarGitPrePush(
  _exec: Executor,
  _raiz: string,
  _existe: (caminho: string) => boolean = existsSync,
): Checagem {
  throw new Error("not implemented");
}

/** `pre-commit` do lefthook instalado — existe e é de fato gerenciado pelo
 * lefthook (não um hook de outra origem com o mesmo nome). */
export function checarLefthook(
  _exec: Executor,
  _raiz: string,
  _existe: (caminho: string) => boolean = existsSync,
  _ler: (caminho: string) => string = (caminho) => readFileSync(caminho, "utf8"),
): Checagem {
  throw new Error("not implemented");
}

function imprimirChecagem(c: Checagem): void {
  if (c.status === "ok") {
    process.stdout.write(`ok     ${c.nome} — ${c.detalhe}\n`);
    return;
  }
  process.stdout.write(`FALTA  ${c.nome} — ${c.detalhe}\n`);
  process.stdout.write(`       resolve com: ${String(c.comando)}\n`);
}

export function main(): void {
  const raiz = process.cwd();
  const checagens: readonly Checagem[] = [
    checarNode(),
    checarToolchainNativo(process.platform, executorReal),
    checarGh(executorReal),
    checarGitPrePush(executorReal, raiz),
    checarLefthook(executorReal, raiz),
  ];
  for (const c of checagens) imprimirChecagem(c);
  const algumaFalta = checagens.some((c) => c.status === "falta");
  process.stdout.write("\n");
  process.stdout.write(
    algumaFalta ? "doutor: falta(s) acima — resolva e rode de novo.\n" : "doutor: tudo certo.\n",
  );
  process.exit(algumaFalta ? 1 : 0);
}

function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`doutor: erro inesperado: ${String(error)}\n`);
    process.exit(1);
  }
}
