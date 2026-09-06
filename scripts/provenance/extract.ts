// Extrai os SHAs aprovados. A fonte canônica é `docs/provenance.json`
// (issue #158); a leitura por regex da tabela Markdown de docs/closeout.md
// permanece por dois motivos: `scripts/provenance/check-ancestry.ts` (fora
// do escopo desta issue) ainda consome `extractApprovedHeads(markdown)`
// diretamente, e o teste bidirecional (JSON ↔ tabela) precisa das duas
// extrações para comparar. Linhas cujo campo de SHA não é um hash completo
// (ex.: o placeholder `EVIDENCE_BOUND_FINAL_SHA` do T22) não são
// silenciosamente ignoradas: voltam em `skipped`, com o texto cru, para o
// chamador decidir o que fazer.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const ROW3 = /^\|\s*(T\d{2})\s*\|\s*`?([^`|]+?)`?\s*\|\s*([^|]+?)\s*\|$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const TICKET = /^T\d{2}$/u;

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
export function extractTableRows(markdown: string): readonly MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  for (const line of markdown.split("\n")) {
    const match = ROW3.exec(line);
    if (match === null) continue;
    const ticket = match[1] as string;
    const sha = (match[2] as string).trim();
    const result = (match[3] as string).trim();
    rows.push({ ticket, sha, result });
  }
  return rows;
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

const defaultProvenancePath = resolve(import.meta.dirname, "..", "..", "docs", "provenance.json");

function fail(path: string, index: number | null, reason: string): never {
  const where = index === null ? path : `${path}:entries[${String(index)}]`;
  throw new Error(`PROVENANCE_SCHEMA:${where}:${reason}`);
}

function validateEntry(entry: unknown, index: number, path: string): ProvenanceEntry {
  if (typeof entry !== "object" || entry === null) {
    fail(path, index, "entry must be an object");
  }
  const record = entry as Record<string, unknown>;
  const { ticket, sha, result, status } = record;
  if (typeof ticket !== "string" || !TICKET.test(ticket)) {
    fail(path, index, `ticket must match T\\d{2}, got ${JSON.stringify(ticket)}`);
  }
  if (typeof sha !== "string" || sha.length === 0) {
    fail(path, index, `sha must be a non-empty string, got ${JSON.stringify(sha)}`);
  }
  if (typeof result !== "string" || result.length === 0) {
    fail(path, index, `result must be a non-empty string, got ${JSON.stringify(result)}`);
  }
  if (status !== "approved" && status !== "pending") {
    fail(path, index, `status must be "approved" or "pending", got ${JSON.stringify(status)}`);
  }
  if (status === "approved" && !FULL_SHA.test(sha)) {
    fail(path, index, `status "approved" requires a 40-hex sha, got ${JSON.stringify(sha)}`);
  }
  return {
    ticket: ticket,
    sha: sha,
    result: result,
    status: status,
  };
}

/**
 * Valida e normaliza um `docs/provenance.json` já parseado (fail-closed:
 * lança com a causa exata do desvio de schema). Pura — não toca disco.
 */
export function parseProvenanceDocument(
  value: unknown,
  path = "docs/provenance.json",
): ProvenanceDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, null, 'document must be an object with an "entries" array');
  }
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    fail(path, null, '"entries" must be an array');
  }
  return { entries: entries.map((entry, index) => validateEntry(entry, index, path)) };
}

/** Lê e valida `docs/provenance.json` (ou o caminho informado). Fail-closed. */
export function readProvenance(path: string = defaultProvenancePath): ProvenanceDocument {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`PROVENANCE_UNREADABLE:${path}:${String(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PROVENANCE_INVALID_JSON:${path}:${String(error)}`, { cause: error });
  }
  return parseProvenanceDocument(parsed, path);
}

/**
 * Pares `[ticket, sha]` das entradas `approved` da fonte canônica, na ordem
 * em que aparecem — o formato que `verify-evidence.ts` consumia como lista
 * literal antes desta issue.
 */
export function approvedHeadPairs(
  document: ProvenanceDocument = readProvenance(),
): readonly (readonly [string, string])[] {
  return document.entries
    .filter((entry) => entry.status === "approved")
    .map((entry) => [entry.ticket, entry.sha] as const);
}
