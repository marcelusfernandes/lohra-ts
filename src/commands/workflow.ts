import type Database from "better-sqlite3";

import { AuditRepository } from "../state/audit-repository.js";
import { openStateDatabase } from "../state/connection.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import { parseAuditQuery } from "../workflow/audit-query.js";

export interface WorkflowCommandOptions {
  readonly action: "list" | "watch" | "audit";
  readonly databasePath: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const TERMINAL = new Set(["complete", "completed", "failed", "cancelled", "paused", "degraded"]);
const STALE_HINT =
  "the process running this workflow is gone; resume it with run_workflow(resume_run_id=...)";

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

function render(
  database: Database.Database,
  repository: WorkflowRepository,
  row: Readonly<Record<string, unknown>>,
  now: number,
): string {
  const runId = String(row.run_id);
  const state = progress(row);
  const spend = repository.getRunSpend(runId);
  const tokens = Number(spend?.tokens_in ?? 0) + Number(spend?.tokens_out ?? 0);
  const budget =
    typeof row.token_budget === "bigint" || typeof row.token_budget === "number"
      ? `/${String(row.token_budget)}`
      : "";
  const stale = isStale(database, row, now) ? " (stale)" : "";
  return `${runId.slice(0, 8)}  ${text(row.status)}${stale}  ${String(state.done)}/${String(state.total)} nodes  ${String(tokens)}${budget} tok  ${text(row.name)}`.trimEnd();
}

export async function runWorkflowCommand(options: WorkflowCommandOptions): Promise<number> {
  const connection = openStateDatabase(options.databasePath);
  try {
    const repository = new WorkflowRepository(connection.database);
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
    for (;;) {
      row = repository.getRunState(runId);
      if (row === null) {
        options.stderr(`workflow run '${runId}' is gone\n`);
        return 1;
      }
      const line = render(connection.database, repository, row, now());
      if (line !== previous) {
        options.stdout(`${line}\n`);
        previous = line;
      }
      if (TERMINAL.has(String(row.status))) return 0;
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
