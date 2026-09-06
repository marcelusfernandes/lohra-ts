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
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

function ok(nome: string, detalhe: string): Checagem {
  return { nome, status: "ok", detalhe };
}

function falta(nome: string, detalhe: string, comando: string): Checagem {
  return { nome, status: "falta", detalhe, comando };
}

// `SpawnSyncReturns<string>.stdout`/`.stderr` são tipados como sempre
// `string` (nunca `| undefined`) em `@types/node`, mas quando o processo nem
// chega a rodar (ENOENT — binário ausente), o Node devolve `undefined` de
// verdade nesses dois campos (mesma observação de `scripts/ci/lib/git.ts`).
function textoOuVazio(valor: string | undefined): string {
  return valor ?? "";
}

/** `Executor` de verdade — só usado por `main()`; os testes nunca importam
 * este símbolo, sempre injetam um duplo nas checagens. */
export const executorReal: Executor = (cmd, args) => {
  const r = spawnSync(cmd, args as string[], { encoding: "utf8", timeout: 10_000 });
  return {
    status: r.status,
    stdout: textoOuVazio(r.stdout),
    stderr: textoOuVazio(r.stderr),
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
};

/** Node >= 20 (`engines.node` do `package.json`). */
export function checarNode(versao: string = process.version): Checagem {
  const major = Number(versao.replace(/^v/u, "").split(".")[0]);
  if (Number.isFinite(major) && major >= 20) return ok("Node", `${versao} (>= 20)`);
  return falta("Node", `${versao} é menor que 20`, "nvm install 20 && nvm use 20");
}

/** `python3`/`make`/`g++` — só exigidos em Linux (build nativo do node-pty;
 * macOS usa o Xcode Command Line Tools, Windows não builda na instalação). */
export function checarToolchainNativo(plataforma: NodeJS.Platform, exec: Executor): Checagem {
  if (plataforma !== "linux") {
    return ok("toolchain nativo (node-pty)", `não exigido em ${plataforma}`);
  }
  const faltando = ["python3", "make", "g++"].filter((cmd) => {
    const r = exec(cmd, ["--version"]);
    return r.error !== undefined || r.status !== 0;
  });
  if (faltando.length === 0) {
    return ok("toolchain nativo (node-pty)", "python3, make, g++ presentes");
  }
  return falta(
    "toolchain nativo (node-pty)",
    `faltando: ${faltando.join(", ")}`,
    "sudo apt-get install -y python3 make g++",
  );
}

/** `gh auth status` — binário ausente e binário presente mas deslogado são
 * duas causas de "falta" distintas, cada uma com o comando certo. */
export function checarGh(exec: Executor): Checagem {
  const r = exec("gh", ["auth", "status"]);
  if (r.error !== undefined) {
    return falta("gh", "gh não encontrado no PATH", "brew install gh && gh auth login");
  }
  if (r.status === 0) return ok("gh", "autenticado");
  return falta("gh", "gh instalado mas não autenticado", "gh auth login");
}

/** Diretório de hooks deste checkout (`git rev-parse --git-path hooks`) —
 * resolve certo mesmo de dentro de um worktree, onde os hooks são os do
 * checkout principal, compartilhados. `undefined` quando não dá para saber
 * (fora de um repo git, ou `git` ausente). */
function localizarHooksDir(exec: Executor, raiz: string): string | undefined {
  const r = exec("git", ["-C", raiz, "rev-parse", "--git-path", "hooks"]);
  if (r.error !== undefined || r.status !== 0) return undefined;
  const caminho = r.stdout.trim();
  return caminho === "" ? undefined : resolve(raiz, caminho);
}

/** `git-pre-push` (camada 2 da proteção da main) instalado no hooks dir
 * deste checkout, com o mesmo conteúdo do canônico versionado
 * (`.claude/hooks/git-pre-push`) — comparado byte a byte, não só existência:
 * um `pre-push` sobrescrito (ex. por `lefthook install` sem escopo) passaria
 * como ok se só a existência fosse checada. */
export function checarGitPrePush(
  exec: Executor,
  raiz: string,
  existe: (caminho: string) => boolean = existsSync,
  ler: (caminho: string) => string = (caminho) => readFileSync(caminho, "utf8"),
): Checagem {
  const hooksDir = localizarHooksDir(exec, raiz);
  if (hooksDir === undefined) {
    return falta(
      "git-pre-push",
      "não foi possível localizar .git/hooks (rode dentro do checkout)",
      "git rev-parse --git-path hooks",
    );
  }
  const destino = resolve(hooksDir, "pre-push");
  if (!existe(destino)) {
    return falta(
      "git-pre-push",
      "hook pre-push não instalado",
      "sh .claude/hooks/instalar-git-hooks.sh",
    );
  }
  const canonico = resolve(raiz, ".claude", "hooks", "git-pre-push");
  if (ler(destino) !== ler(canonico)) {
    return falta(
      "git-pre-push",
      `hook pre-push em ${destino} difere do canônico (${canonico})`,
      "sh .claude/hooks/instalar-git-hooks.sh",
    );
  }
  return ok("git-pre-push", `instalado em ${destino}`);
}

/** `pre-commit` do lefthook instalado — existe e é de fato gerenciado pelo
 * lefthook (não um hook de outra origem com o mesmo nome). */
export function checarLefthook(
  exec: Executor,
  raiz: string,
  existe: (caminho: string) => boolean = existsSync,
  ler: (caminho: string) => string = (caminho) => readFileSync(caminho, "utf8"),
): Checagem {
  const hooksDir = localizarHooksDir(exec, raiz);
  if (hooksDir === undefined) {
    return falta(
      "lefthook",
      "não foi possível localizar .git/hooks (rode dentro do checkout)",
      "npx lefthook install pre-commit",
    );
  }
  const destino = resolve(hooksDir, "pre-commit");
  if (!existe(destino)) {
    return falta("lefthook", "hook pre-commit (lefthook) não instalado", "npm ci");
  }
  const conteudo = ler(destino);
  if (!conteudo.toLowerCase().includes("lefthook")) {
    return falta(
      "lefthook",
      "pre-commit existe mas não é gerenciado pelo lefthook",
      "npx lefthook install pre-commit --force",
    );
  }
  return ok("lefthook", `instalado em ${destino}`);
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
