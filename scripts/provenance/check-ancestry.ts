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
//     passado — nesse caso são toleradas (nem checadas, nem contam como
//     falha). Essa distinção é o que permite ao mesmo comando reprovar em
//     push para `main` e tolerar em PR (issue #160 liga a flag ao evento).
//
// Uso:
//   npm run provenance:check                  -- texto, saída preservada
//   npm run provenance:check -- --json        -- {checked, ok, failures, skipped}
//   npm run provenance:check -- --pending-ok  -- tolera "pending" com SHA real
//
// Exit codes:
//   0 — ok (nenhuma falha, respeitando --pending-ok)
//   1 — pelo menos uma falha (SHA_UNKNOWN | NOT_ANCESTOR | SHALLOW_CLONE | PENDING)
//   2 — guarda: docs/provenance.json ilegível, com schema inválido, ou sem
//       nenhuma entrada (a mesma guarda que já existia para a tabela vazia)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readProvenance, type ProvenanceDocument } from "./extract.js";

const root = resolve(import.meta.dirname, "..", "..");
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

/** Lança se `docs/provenance.json` não tiver nenhuma entrada — a mesma
 * guarda fail-closed que o script sempre teve para uma tabela vazia. */
export function validateDocument(document: ProvenanceDocument): void {
  if (document.entries.length === 0) {
    throw new Error("no entries found in docs/provenance.json");
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
  const failures: Failure[] = [];

  for (const entry of document.entries) {
    if (entry.status === "pending") {
      if (!FULL_SHA.test(entry.sha)) {
        skipped += 1;
        continue;
      }
      if (!options.pendingOk) {
        failures.push({ ticket: entry.ticket, sha: entry.sha, cause: "PENDING" });
      }
      continue;
    }
    checked += 1;
    const cause = classifyApproved(runGit, entry.sha, shallow);
    if (cause !== null) failures.push({ ticket: entry.ticket, sha: entry.sha, cause });
  }

  return { checked, ok: failures.length === 0, failures, skipped };
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
function writeTextReport(document: ProvenanceDocument, outcome: CheckOutcome): void {
  for (const entry of document.entries) {
    if (entry.status === "pending" && !FULL_SHA.test(entry.sha)) {
      process.stderr.write(`provenance: ${entry.ticket} skipped — not a full SHA: ${entry.sha}\n`);
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

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const pendingOk = args.includes("--pending-ok");

  let document: ProvenanceDocument;
  try {
    document = readProvenance();
    validateDocument(document);
  } catch (error) {
    process.stderr.write(`provenance: cannot read docs/provenance.json: ${String(error)}\n`);
    process.exit(2);
  }

  const outcome = evaluateProvenance(document, realGit(root), { pendingOk });
  if (jsonMode) writeJsonReport(outcome);
  else writeTextReport(document, outcome);
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
