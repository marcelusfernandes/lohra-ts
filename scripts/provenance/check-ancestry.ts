// provenance:check — causas nomeadas, `--json` e `--pending-ok` (issue #159).
//
// Fonte: `docs/provenance.json` (issue #158), via `readProvenance()` de
// `./extract.js` — não mais a tabela Markdown de `docs/closeout.md`. Cada
// entrada `approved` (SHA sempre 40 hex, garantido pelo schema de
// `extract.ts`) é verificada com dois comandos `git`: `cat-file -e
// <sha>^{commit}` (o SHA existe neste repositório?) e, se existir,
// `merge-base --is-ancestor <sha> HEAD` (é ancestral do HEAD?). Um clone
// raso (`git rev-parse --is-shallow-repository`) pode fazer os dois
// comandos falharem sem que a proveniência esteja quebrada de verdade — por
// isso, com o repositório raso, a causa vira `SHALLOW_CLONE` em vez de
// `SHA_UNKNOWN`/`NOT_ANCESTOR`. O job `provenance` do CI roda com
// `fetch-depth: 0` por causa disso.
//
// Entradas `pending`:
//   - sem SHA de 40 hex (placeholder, ex.: `EVIDENCE_BOUND_FINAL_SHA` do
//     T22): nunca são checadas contra o git nem reprovam — contam em
//     `skipped`, informativo.
//   - com SHA de 40 hex (uma decisão ainda não fechada, mas já com commit
//     real): reprovam com a causa `PENDING`, a menos que `--pending-ok` seja
//     passado — nesse caso são toleradas (nem checadas contra o git, nem
//     contam como falha; entram em `tolerated` no `--json`, para quem
//     consome a saída distinguir "nunca existiu de verdade" de "tolerado
//     desta vez"). Essa distinção é o que permite ao mesmo comando reprovar
//     em push para `main` e tolerar em PR (issue #160 liga a flag ao evento).
//
// Guarda fail-closed (rodada 2 da PR #172, revisor): pelo menos uma entrada
// `approved` é obrigatória — um `docs/provenance.json` só com `pending`
// (ou vazio) sai 2 com a causa `PROVENANCE_EMPTY`, nunca `0/0` silencioso.
//
// Uso:
//   npm run provenance:check                        -- texto, saída preservada
//   npm run provenance:check -- --json               -- {checked, ok, failures, skipped, tolerated}
//   npm run provenance:check -- --pending-ok         -- tolera "pending" com SHA real
//   npm run provenance:check -- --provenance <path>  -- outro arquivo (default: docs/provenance.json);
//                                                        os comandos git rodam com cwd = process.cwd()
//                                                        (não a raiz deste repositório) — é o que permite
//                                                        ao caso de CLI de ponta a ponta em
//                                                        tests/provenance-check.test.ts rodar contra um
//                                                        repositório git temporário, independente da
//                                                        profundidade do clone deste repositório.
//
// Exit codes:
//   0 — ok (nenhuma falha, respeitando --pending-ok)
//   1 — pelo menos uma falha (SHA_UNKNOWN | NOT_ANCESTOR | SHALLOW_CLONE | PENDING)
//   2 — guarda: docs/provenance.json (ou --provenance) ilegível, com schema
//       inválido, ou sem nenhuma entrada `approved` (PROVENANCE_EMPTY)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readProvenance, type ProvenanceDocument } from "./extract.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export type FailureCause = "SHA_UNKNOWN" | "NOT_ANCESTOR" | "SHALLOW_CLONE" | "PENDING";

export interface Failure {
  readonly ticket: string;
  readonly sha: string;
  readonly cause: FailureCause;
}

export interface CheckOutcome {
  readonly checked: number;
  readonly ok: boolean;
  readonly failures: readonly Failure[];
  readonly skipped: number;
  readonly tolerated: number;
}

/** Resultado de uma chamada de `git`: status de saída e stdout — precisa do
 * stdout porque `rev-parse --is-shallow-repository` sempre sai 0 e imprime
 * "true"/"false". Injetável: os testes unitários passam um fake em vez de
 * rodar `git` de verdade (`tests/provenance-check.test.ts`). */
export interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

export type GitRunner = (args: readonly string[]) => GitResult;

// `SpawnSyncReturns<string>.stdout` é tipado como sempre `string` em
// `@types/node`, mas quando o processo nem chega a rodar (ENOENT — `git`
// ausente do PATH) o Node devolve `undefined` de verdade. O `??` cobre esse
// caso real que o tipo declarado esconde; o cast é o que torna o fallback
// necessário aos olhos do `no-unnecessary-condition` (mesmo idioma de
// `scripts/ci/lib/git.ts`).
function stdoutOuVazio(valor: string | undefined): string {
  return valor ?? "";
}

/** `GitRunner` real, via `spawnSync`. */
export function realGit(cwd: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", args as string[], { cwd, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: stdoutOuVazio(result.stdout) };
  };
}

export function isShallowClone(runGit: GitRunner): boolean {
  return runGit(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
}

function shaExists(runGit: GitRunner, sha: string): boolean {
  return runGit(["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

function isAncestorOfHead(runGit: GitRunner, sha: string): boolean {
  return runGit(["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0;
}

/** Classifica uma entrada `approved` (SHA já validado como 40 hex pelo
 * schema de `extract.ts`): `null` quando é ancestral do HEAD, senão a causa
 * nomeada — nunca um booleano genérico que esconde o motivo. */
export function classifyApproved(
  runGit: GitRunner,
  sha: string,
  shallow: boolean,
): FailureCause | null {
  if (!shaExists(runGit, sha)) return shallow ? "SHALLOW_CLONE" : "SHA_UNKNOWN";
  if (!isAncestorOfHead(runGit, sha)) return shallow ? "SHALLOW_CLONE" : "NOT_ANCESTOR";
  return null;
}

/**
 * Lança se `document` não tiver nenhuma entrada `approved` — a mesma guarda
 * fail-closed que o baseline tinha (`approved.length === 0`, quando a fonte
 * era a tabela Markdown). `entries.length === 0` sozinho não bastava: um
 * `docs/provenance.json` só com `pending` também precisa reprovar aqui,
 * senão `evaluateProvenance` imprime `0/0` e `main()` sai 0 — um gate verde
 * sem checar SHA nenhum contra o git (regressão pega na rodada 1 da PR #172).
 */
export function validateDocument(document: ProvenanceDocument, path: string): void {
  const approvedCount = document.entries.filter((entry) => entry.status === "approved").length;
  if (approvedCount === 0) {
    throw new Error(`PROVENANCE_EMPTY:${path}:no approved entries found`);
  }
}

/**
 * Avalia todas as entradas de `docs/provenance.json` contra o `HEAD` atual.
 * Pura o bastante para teste unitário: `runGit` é sempre injetado, o
 * classificador nunca chama `spawnSync` direto.
 */
export function evaluateProvenance(
  document: ProvenanceDocument,
  runGit: GitRunner,
  options: { readonly pendingOk: boolean },
): CheckOutcome {
  const shallow = isShallowClone(runGit);
  let checked = 0;
  let skipped = 0;
  let tolerated = 0;
  const failures: Failure[] = [];

  for (const entry of document.entries) {
    if (entry.status === "pending") {
      if (!FULL_SHA.test(entry.sha)) {
        skipped += 1;
        continue;
      }
      if (options.pendingOk) {
        tolerated += 1;
      } else {
        failures.push({ ticket: entry.ticket, sha: entry.sha, cause: "PENDING" });
      }
      continue;
    }
    checked += 1;
    const cause = classifyApproved(runGit, entry.sha, shallow);
    if (cause !== null) failures.push({ ticket: entry.ticket, sha: entry.sha, cause });
  }

  return { checked, ok: failures.length === 0, failures, skipped, tolerated };
}

const CAUSE_TEXT: Record<FailureCause, (ticket: string, sha: string) => string> = {
  SHA_UNKNOWN: (ticket, sha) =>
    `provenance: ${ticket} ${sha} is unknown to this repository (git cat-file -e failed)`,
  NOT_ANCESTOR: (ticket, sha) => `provenance: ${ticket} ${sha} is NOT an ancestor of HEAD`,
  SHALLOW_CLONE: (ticket, sha) =>
    `provenance: ${ticket} ${sha} cannot be verified — shallow clone (needs fetch-depth: 0)`,
  PENDING: (ticket, sha) =>
    `provenance: ${ticket} ${sha} is pending — rerun with --pending-ok to tolerate`,
};

/** Formato texto — o mesmo shape que o script sempre teve: linhas
 * informativas de `skipped` no stderr, uma linha por falha no stderr, e o
 * resumo no stdout. */
function writeTextReport(
  document: ProvenanceDocument,
  outcome: CheckOutcome,
  pendingOk: boolean,
): void {
  for (const entry of document.entries) {
    if (entry.status !== "pending") continue;
    if (!FULL_SHA.test(entry.sha)) {
      process.stderr.write(`provenance: ${entry.ticket} skipped — not a full SHA: ${entry.sha}\n`);
    } else if (pendingOk) {
      process.stderr.write(
        `provenance: ${entry.ticket} ${entry.sha} is pending — tolerated (--pending-ok)\n`,
      );
    }
  }
  for (const failure of outcome.failures) {
    process.stderr.write(`${CAUSE_TEXT[failure.cause](failure.ticket, failure.sha)}\n`);
  }
  const approvedFailures = outcome.failures.filter((failure) => failure.cause !== "PENDING").length;
  process.stdout.write(
    `provenance: ${String(outcome.checked - approvedFailures)}/${String(outcome.checked)} approved heads are ancestors of HEAD\n`,
  );
}

function writeJsonReport(outcome: CheckOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

/** `--flag <valor>`: `undefined` quando `flag` não está presente; sai 2 se
 * `flag` está presente mas sem valor depois (nunca lê o próximo argumento às
 * cegas). */
function findFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) {
    process.stderr.write(`provenance: ${flag} requires a value\n`);
    process.exit(2);
  }
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const pendingOk = args.includes("--pending-ok");
  const provenanceArg = findFlagValue(args, "--provenance");
  const pathForMessage = provenanceArg ?? "docs/provenance.json";

  let document: ProvenanceDocument;
  try {
    document =
      provenanceArg !== undefined ? readProvenance(resolve(provenanceArg)) : readProvenance();
    validateDocument(document, pathForMessage);
  } catch (error) {
    process.stderr.write(`provenance: cannot use ${pathForMessage}: ${String(error)}\n`);
    process.exit(2);
  }

  // `process.cwd()`, não a raiz deste repositório: é o que deixa
  // tests/provenance-check.test.ts apontar os comandos git para um
  // repositório temporário via `spawnSync(..., { cwd })`, sem depender da
  // profundidade do clone deste repositório (rodada 2 da PR #172).
  const outcome = evaluateProvenance(document, realGit(process.cwd()), { pendingOk });
  if (jsonMode) writeJsonReport(outcome);
  else writeTextReport(document, outcome, pendingOk);
  process.exit(outcome.ok ? 0 : 1);
}

// Só roda `main()` quando este arquivo é o entry point (`tsx
// scripts/provenance/check-ancestry.ts`) — nunca quando um teste importa as
// funções puras diretamente, o que rodaria `git`/`process.exit` de verdade
// com o `process.argv` do test runner (mesmo idioma de `scripts/prova/run.ts`).
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  main();
}
