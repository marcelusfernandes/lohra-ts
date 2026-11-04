// Issue #973 (épico #969): the per-template scoreboard — how many runs each
// library template started (`template_ref`, #971), how they ended, when it
// was last used and what a run of it costs on average. A query over the
// rows that already exist (`workflow_run_state` + `workflow_run_spend`), no
// new table; `workflow_templates` and `lohra workflow templates` read it so
// the agent and the operator see the same numbers, and #949 has its input.
import type { TemplateRunStatusRow } from "../state/workflow-repository.js";

/** Rows `templateRunStats` may return: one per (template, status) pair —
 * invariant 3, the listing is never unbounded. */
export const TEMPLATE_STATS_ROW_LIMIT = 5_000;

export interface TemplateStats {
  readonly runs: number;
  readonly complete: number;
  readonly degraded: number;
  readonly failed: number;
  readonly paused: number;
  readonly cancelled: number;
  readonly running: number;
  /** Any other status (e.g. a future one) — counted, never dropped. */
  readonly other: number;
  /** Seconds since the epoch, `null` for a template never run. */
  readonly last_used_at: number | null;
  readonly avg_tokens: number;
}

export const EMPTY_TEMPLATE_STATS: TemplateStats = Object.freeze({
  runs: 0,
  complete: 0,
  degraded: 0,
  failed: 0,
  paused: 0,
  cancelled: 0,
  running: 0,
  other: 0,
  last_used_at: null,
  avg_tokens: 0,
});

type StatusBucket = "complete" | "degraded" | "failed" | "paused" | "cancelled" | "running";
const BUCKETS: ReadonlySet<string> = new Set<StatusBucket>([
  "complete",
  "degraded",
  "failed",
  "paused",
  "cancelled",
  "running",
]);

interface Accumulator {
  counts: Record<StatusBucket | "other", number>;
  runs: number;
  tokens: number;
  last: number | null;
}

/** Folds the (template, status) rows into one `TemplateStats` per ref. */
export function foldTemplateStats(
  rows: readonly TemplateRunStatusRow[],
): ReadonlyMap<string, TemplateStats> {
  const byRef = new Map<string, Accumulator>();
  for (const row of rows) {
    const acc = byRef.get(row.template_ref) ?? {
      counts: {
        complete: 0,
        degraded: 0,
        failed: 0,
        paused: 0,
        cancelled: 0,
        running: 0,
        other: 0,
      },
      runs: 0,
      tokens: 0,
      last: null,
    };
    const bucket = BUCKETS.has(row.status) ? (row.status as StatusBucket) : "other";
    acc.counts[bucket] += row.runs;
    acc.runs += row.runs;
    acc.tokens += row.tokens;
    acc.last = acc.last === null ? row.last_used_at : Math.max(acc.last, row.last_used_at);
    byRef.set(row.template_ref, acc);
  }
  const out = new Map<string, TemplateStats>();
  for (const [ref, acc] of byRef) {
    out.set(
      ref,
      Object.freeze({
        runs: acc.runs,
        ...acc.counts,
        last_used_at: acc.last,
        avg_tokens: acc.runs === 0 ? 0 : Math.round(acc.tokens / acc.runs),
      }),
    );
  }
  return out;
}

/** What `listTemplates` needs from the state database. */
export interface TemplateStatsSource {
  templateRunStats(limit: number): readonly TemplateRunStatusRow[];
}

/** The scoreboard plus whether the row cap cut it short — a truncated
 * scoreboard is said so, never passed off as complete. */
export interface TemplateScoreboard {
  readonly byRef: ReadonlyMap<string, TemplateStats>;
  readonly truncated: boolean;
}

export function readTemplateStats(
  source: TemplateStatsSource,
  limit: number = TEMPLATE_STATS_ROW_LIMIT,
): TemplateScoreboard {
  const rows = source.templateRunStats(limit);
  return { byRef: foldTemplateStats(rows), truncated: rows.length >= limit };
}
