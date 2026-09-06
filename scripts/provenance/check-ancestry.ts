// Falha se algum SHA aprovado em docs/closeout.md não for ancestral do HEAD.
// Uso: npm run provenance:check  (CI: job `provenance`, com fetch-depth: 0)
//
// issue #159 (test(red)): as exportações abaixo são stubs — a implementação
// real (leitura de docs/provenance.json, --json, --pending-ok, causas
// nomeadas) ainda não existe; `tests/provenance-check.test.ts` importa esses
// nomes e falha em runtime ao chamá-los, não em tempo de compilação. O corpo
// original do script foi movido para dentro de `main()`, atrás de um guard
// de entry point, para que importar este módulo num teste não dispare
// `process.exit` (mesmo idioma de `scripts/prova/run.ts`).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { extractApprovedHeads } from "./extract.js";
import type { ProvenanceDocument } from "./extract.js";

function main(): void {
  const root = resolve(import.meta.dirname, "..", "..");
  const tablePath = resolve(root, "docs", "closeout.md");

  let markdown: string;
  try {
    markdown = readFileSync(tablePath, "utf8");
  } catch (error) {
    process.stderr.write(`provenance: cannot read ${tablePath}: ${String(error)}\n`);
    process.exit(2);
  }

  const { approved, skipped } = extractApprovedHeads(markdown);
  if (approved.length === 0) {
    process.stderr.write(`provenance: no approved SHA found in ${tablePath}\n`);
    process.exit(2);
  }

  for (const row of skipped) {
    process.stderr.write(`provenance: ${row.ticket} skipped — not a full SHA: ${row.raw}\n`);
  }

  const failures = approved.filter(({ sha }) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    return result.status !== 0;
  });

  for (const { ticket, sha } of failures) {
    process.stderr.write(`provenance: ${ticket} ${sha} is NOT an ancestor of HEAD\n`);
  }
  process.stdout.write(
    `provenance: ${String(approved.length - failures.length)}/${String(approved.length)} approved heads are ancestors of HEAD\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  main();
}

// --- issue #159: stubs para tests/provenance-check.test.ts (test(red)) ---

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

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

export type GitRunner = (args: readonly string[]) => GitResult;

function notImplemented(name: string): never {
  throw new Error(`not implemented (issue #159): ${name}`);
}

export function isShallowClone(_runGit: GitRunner): boolean {
  return notImplemented("isShallowClone");
}

export function classifyApproved(
  _runGit: GitRunner,
  _sha: string,
  _shallow: boolean,
): FailureCause | null {
  return notImplemented("classifyApproved");
}

export function validateDocument(_document: ProvenanceDocument): void {
  notImplemented("validateDocument");
}

export function evaluateProvenance(
  _document: ProvenanceDocument,
  _runGit: GitRunner,
  _options: { readonly pendingOk: boolean },
): CheckOutcome {
  return notImplemented("evaluateProvenance");
}
