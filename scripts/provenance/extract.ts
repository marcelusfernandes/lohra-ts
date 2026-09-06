// Extrai os SHAs aprovados. A fonte canônica é `docs/provenance.json`
// (issue #158); a leitura por regex da tabela Markdown de docs/closeout.md
// permanece por dois motivos: `scripts/provenance/check-ancestry.ts` (fora
// do escopo desta issue) ainda consome `extractApprovedHeads(markdown)`
// diretamente, e o teste bidirecional (JSON ↔ tabela) precisa das duas
// extrações para comparar. Linhas cujo campo de SHA não é um hash completo
// (ex.: o placeholder `EVIDENCE_BOUND_FINAL_SHA` do T22) não são
// silenciosamente ignoradas: voltam em `skipped`, com o texto cru, para o
// chamador decidir o que fazer.
//
// RED (issue #158, ainda não implementado): extractTableRows,
// parseProvenanceDocument, readProvenance e approvedHeadPairs existem só
// como stubs que lançam — os testes novos (tests/provenance-extract.test.ts,
// tests/t22-closeout.test.ts) reprovam em runtime contra este commit.

export interface ApprovedHead {
  readonly ticket: string;
  readonly sha: string;
}

export interface SkippedRow {
  readonly ticket: string;
  readonly raw: string;
}

export interface ProvenanceTable {
  readonly approved: readonly ApprovedHead[];
  readonly skipped: readonly SkippedRow[];
}

const ROW = /^\|\s*(T\d{2})\s*\|\s*`?([^`|]+?)`?\s*\|/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;

/**
 * Extração por regex da tabela Markdown de `docs/closeout.md`. Mantida para
 * `check-ancestry.ts` e para o teste bidirecional; não é mais a fonte
 * canônica (ver `docs/provenance.json` e `readProvenance`).
 */
export function extractApprovedHeads(markdown: string): ProvenanceTable {
  const approved: ApprovedHead[] = [];
  const skipped: SkippedRow[] = [];
  for (const line of markdown.split("\n")) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const ticket = match[1] as string;
    const raw = (match[2] as string).trim();
    if (FULL_SHA.test(raw)) approved.push({ ticket, sha: raw });
    else skipped.push({ ticket, raw });
  }
  return { approved, skipped };
}

/**
 * Uma linha da tabela Markdown, com as três colunas (para o teste
 * bidirecional comparar contra uma entrada de `docs/provenance.json`).
 */
export interface MarkdownRow {
  readonly ticket: string;
  readonly sha: string;
  readonly result: string;
}

/** Extração por regex das três colunas da tabela — só para o teste bidirecional. */
export function extractTableRows(_markdown: string): readonly MarkdownRow[] {
  throw new Error("not implemented (#158): extractTableRows");
}

export type ProvenanceStatus = "approved" | "pending";

export interface ProvenanceEntry {
  readonly ticket: string;
  readonly sha: string;
  readonly result: string;
  readonly status: ProvenanceStatus;
}

export interface ProvenanceDocument {
  readonly entries: readonly ProvenanceEntry[];
}

/**
 * Valida e normaliza um `docs/provenance.json` já parseado (fail-closed:
 * lança com a causa exata do desvio de schema). Pura — não toca disco.
 */
export function parseProvenanceDocument(
  _value: unknown,
  _path = "docs/provenance.json",
): ProvenanceDocument {
  throw new Error("not implemented (#158): parseProvenanceDocument");
}

/** Lê e valida `docs/provenance.json` (ou o caminho informado). Fail-closed. */
export function readProvenance(_path?: string): ProvenanceDocument {
  throw new Error("not implemented (#158): readProvenance");
}

/**
 * Pares `[ticket, sha]` das entradas `approved` da fonte canônica, na ordem
 * em que aparecem — o formato que `verify-evidence.ts` consumia como lista
 * literal antes desta issue.
 */
export function approvedHeadPairs(
  _document?: ProvenanceDocument,
): readonly (readonly [string, string])[] {
  throw new Error("not implemented (#158): approvedHeadPairs");
}
