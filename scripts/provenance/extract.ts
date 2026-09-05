// Extrai os SHAs aprovados da tabela de proveniência em docs/closeout.md.
//
// A fonte canônica da lista é decisão do épico de proveniência (#9); até lá,
// a tabela Markdown é lida por regex. Linhas cujo campo de SHA não é um hash
// completo (ex.: o placeholder `EVIDENCE_BOUND_FINAL_SHA` do T22) não são
// silenciosamente ignoradas: voltam em `skipped`, com o texto cru, para o
// chamador decidir o que fazer.

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
