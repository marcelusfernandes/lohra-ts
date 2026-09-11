import type Database from "better-sqlite3";

import { AuditRepository } from "../state/audit-repository.js";
import { openStateDatabase } from "../state/connection.js";
import { NoticesRepository, type PublicNotice } from "../state/notices-repository.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import { parseAuditQuery } from "../workflow/audit-query.js";
import type { PublicAuditEvent } from "../workflow/audit-model.js";
import { productionWarningSink } from "../workflow/ownership-store.js";
import {
  CHECKPOINT_HINT,
  CHECKPOINT_PAUSE,
  STALE_HINT,
  TOKEN_BUDGET_HINT,
  TOKEN_BUDGET_PAUSE,
  USER_PAUSE,
  USER_PAUSE_HINT,
} from "../workflow/service.js";

export interface WorkflowCommandOptions {
  readonly action: "list" | "watch" | "audit" | "notices";
  readonly databasePath: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const TERMINAL = new Set(["complete", "completed", "failed", "cancelled", "paused", "degraded"]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function progress(row: Readonly<Record<string, unknown>>): { done: number; total: number } {
  try {
    const parsed = JSON.parse(text(row.progress_json) || "{}") as Readonly<Record<string, unknown>>;
    return {
      done: typeof parsed.done === "number" ? Math.trunc(parsed.done) : 0,
      total: typeof parsed.total === "number" ? Math.trunc(parsed.total) : 0,
    };
  } catch {
    return { done: 0, total: 0 };
  }
}

function isStale(
  database: Database.Database,
  row: Readonly<Record<string, unknown>>,
  now: number,
): boolean {
  if (String(row.status) !== "running") return false;
  return (
    database
      .prepare("SELECT 1 FROM workflow_run_locks WHERE run_id=? AND expires_at > ?")
      .get(row.run_id, now) === undefined
  );
}

/** The retry hint for a `pause_reason` (`src/workflow/service.ts`, the same
 * text `run_workflow`'s tool surface returns). `quota_exhausted` has none —
 * it auto-resumes; there's nothing for the operator to do. */
function pauseHint(pauseReason: string): string | null {
  if (pauseReason === CHECKPOINT_PAUSE) return CHECKPOINT_HINT;
  if (pauseReason === TOKEN_BUDGET_PAUSE) return TOKEN_BUDGET_HINT;
  if (pauseReason === USER_PAUSE) return USER_PAUSE_HINT;
  return null;
}

/** `seq  event_type  node_path  sub_id?  segment_id[:8]` — one line per
 * ledger event, for `--events` (issue #369). */
function renderAuditLine(event: PublicAuditEvent): string {
  const identity = event.identity;
  const nodePath = Array.isArray(identity.node_path) ? identity.node_path.join(".") : "";
  const subId = typeof identity.sub_id === "string" ? ` ${identity.sub_id}` : "";
  const segmentId =
    typeof identity.segment_id === "string" ? ` ${identity.segment_id.slice(0, 8)}` : "";
  return `${String(event.seq)}  ${event.event_type}  ${nodePath}${subId}${segmentId}`.trimEnd();
}

/** `id  scope  kind  [acked]  message` — one line per notice, for the text
 * (non-`--json`) rendering of `lohra workflow notices` (issue #402). */
function renderNoticeLine(notice: PublicNotice): string {
  const acked = notice.acked_at !== null ? " (acked)" : "";
  return `${String(notice.id)}  ${notice.scope}  ${notice.kind}${acked}  ${notice.message}`;
}

/** Drains every not-yet-shown event from `after_seq` on, printing each one
 * exactly once and advancing the cursor past it — the durable ledger
 * (`AuditRepository`), because `watch` runs in a different process than
 * whatever launched the run and never sees `onLiveEvent` (that live surface
 * is `workflow_status.live_tail`, in-process only). Never re-reads what it
 * already printed, even across many `has_more` pages in one poll. */
function drainAuditEvents(
  audit: AuditRepository,
  runId: string,
  cursor: number,
  stdout: (value: string) => void,
): number {
  let after = cursor;
  for (;;) {
    const page = audit.query({ runId, afterSeq: after, limit: 100 });
    for (const event of page.events) stdout(`${renderAuditLine(event)}\n`);
    const next = typeof page.page.next_after_seq === "number" ? page.page.next_after_seq : after;
    if (page.events.length === 0 || next === after) return next;
    after = next;
    if (page.page.has_more !== true) return after;
  }
}

function render(
  database: Database.Database,
  repository: WorkflowRepository,
  row: Readonly<Record<string, unknown>>,
  now: number,
): string {
  const runId = String(row.run_id);
  const status = text(row.status);
  const state = progress(row);
  const spend = repository.getRunSpend(runId);
  const tokens = Number(spend?.tokens_in ?? 0) + Number(spend?.tokens_out ?? 0);
  const budgetValue =
    typeof row.token_budget === "bigint" || typeof row.token_budget === "number"
      ? Number(row.token_budget)
      : null;
  const budget = budgetValue === null ? "" : `/${String(budgetValue)}`;
  const over =
    budgetValue !== null && tokens > budgetValue ? ` (+${String(tokens - budgetValue)} over)` : "";
  const stale = isStale(database, row, now) ? " (stale)" : "";
  const pauseReason = status === "paused" ? text(row.pause_reason) : "";
  const pauseSuffix = pauseReason !== "" ? ` (${pauseReason})` : "";
  return `${runId.slice(0, 8)}  ${status}${stale}${pauseSuffix}  ${String(state.done)}/${String(state.total)} nodes  ${String(tokens)}${budget} tok${over}  ${text(row.name)}`.trimEnd();
}

export async function runWorkflowCommand(options: WorkflowCommandOptions): Promise<number> {
  const connection = openStateDatabase(options.databasePath);
  try {
    // Read-only here (list/watch/audit never take a lease or write a run
    // line), so no owned write of this repository's can ever be refused —
    // wired for coherence with the other two production sites (#135), not
    // because a warning is expected in practice.
    const repository = new WorkflowRepository(
      connection.database,
      productionWarningSink((message) => {
        options.stderr(`${message}\n`);
      }),
    );
    const now = options.now ?? (() => Date.now() / 1_000);
    if (options.action === "audit") {
      const parsed = parseAuditQuery(options.args);
      if ("error" in parsed) {
        options.stderr(`${parsed.error}\n`);
        return 2;
      }
      const page = new AuditRepository(connection.database).query(parsed.query);
      options.stdout(`${JSON.stringify(page, null, 2)}\n`);
      return 0;
    }
    if (options.action === "notices") {
      const notices = new NoticesRepository(connection.database);
      const json = options.args.json === true;
      const ackRaw = options.args.ack;
      if (ackRaw !== undefined) {
        const id = typeof ackRaw === "number" ? ackRaw : Number(ackRaw);
        if (!Number.isInteger(id) || id <= 0) {
          options.stderr("--ack requires a positive integer id\n");
          return 2;
        }
        const acked = notices.ack(id, "cli", now());
        if (json) options.stdout(`${JSON.stringify({ acked }, null, 2)}\n`);
        else options.stdout(acked ? `acked ${String(id)}\n` : `no notice ${String(id)} to ack\n`);
        return 0;
      }
      const runId =
        typeof options.args.run_id === "string" && options.args.run_id !== ""
          ? options.args.run_id
          : undefined;
      const afterSeq =
        typeof options.args.after_seq === "number" ? options.args.after_seq : undefined;
      const page = notices.list({
        ...(runId === undefined ? {} : { scope: `run:${runId}` }),
        includeAcked: options.args.all === true,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      if (json) {
        options.stdout(`${JSON.stringify(page, null, 2)}\n`);
      } else if (page.notices.length === 0) {
        options.stdout("no notices\n");
      } else {
        for (const notice of page.notices) options.stdout(`${renderNoticeLine(notice)}\n`);
      }
      return 0;
    }
    const limit = Math.min(100, Math.max(0, Number(options.args.limit ?? 20)));
    if (options.action === "list") {
      const lines = repository
        .recentRunStates(limit)
        .map((row) => render(connection.database, repository, row, now()));
      options.stdout(lines.length === 0 ? "no workflow runs\n" : `${lines.join("\n")}\n`);
      return 0;
    }
    let runId = typeof options.args.run_id === "string" ? options.args.run_id : undefined;
    if (runId === undefined && options.args.last === true) {
      const recent = repository.recentRunStates(1)[0]?.run_id;
      runId = typeof recent === "string" && recent !== "" ? recent : undefined;
    }
    if (runId === undefined) {
      options.stderr("watch needs a run id (or --last)\n");
      return 2;
    }
    let row = repository.getRunState(runId);
    if (row === null) {
      options.stderr(`no workflow run '${runId}'\n`);
      return 1;
    }
    let previous: string | undefined;
    const sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const poll = Math.max(0, Number(options.args.poll ?? 2) * 1_000);
    const showEvents = options.args.events === true;
    const audit = showEvents ? new AuditRepository(connection.database) : undefined;
    let eventsCursor = 0;
    for (;;) {
      row = repository.getRunState(runId);
      if (row === null) {
        options.stderr(`workflow run '${runId}' is gone\n`);
        return 1;
      }
      if (audit !== undefined)
        eventsCursor = drainAuditEvents(audit, runId, eventsCursor, options.stdout);
      const line = render(connection.database, repository, row, now());
      if (line !== previous) {
        options.stdout(`${line}\n`);
        previous = line;
      }
      if (TERMINAL.has(String(row.status))) {
        if (String(row.status) === "paused") {
          const hint = pauseHint(text(row.pause_reason));
          if (hint !== null) options.stderr(`${hint}\n`);
        }
        return 0;
      }
      if (isStale(connection.database, row, now())) {
        options.stderr(`${STALE_HINT}\n`);
        return 0;
      }
      await sleep(poll);
    }
  } finally {
    connection.close();
  }
}
