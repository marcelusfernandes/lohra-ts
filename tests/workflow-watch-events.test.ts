// Issue #369: `lohra workflow watch --events` follows the durable ledger
// (`AuditRepository`, cross-process-honest — `watch` runs in another
// process from whatever launched the run and never sees `onLiveEvent`) by
// `after_seq` cursor, printing each event exactly once alongside the
// existing state line. Molded on `tests/workflow-command.test.ts`'s harness
// (`tmpDatabase`/`insertRun`/`run`) — duplicated here rather than imported,
// same as every other file in this suite (`workflow-command.test.ts` itself
// is in `prova/audit-live-tail.ts`'s Proof list, unmodified, to prove
// `--events` never changes the no-flag path).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runWorkflowCommand } from "../src/commands/workflow.js";
import { AuditRepository } from "../src/state/audit-repository.js";
import { openStateDatabase, WorkflowRepository, type StateConnection } from "../src/state/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDatabase(): StateConnection & { readonly databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra-t369-watch-events-"));
  roots.push(root);
  const databasePath = join(root, "state.db");
  return { ...openStateDatabase(databasePath), databasePath };
}

function insertRun(
  connection: StateConnection,
  runId: string,
  status: string,
  updatedAt = 0,
): void {
  new WorkflowRepository(connection.database).putRunState(runId, {
    name: `run-${runId}`,
    owner: null,
    status,
    pauseReason: null,
    pausePayloadJson: null,
    specJson: null,
    argsJson: null,
    tokenBudget: null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt,
    fence: null,
    holder: null,
    now: updatedAt,
    requireUnleased: true,
  });
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  options: Omit<Parameters<typeof runWorkflowCommand>[0], "stdout" | "stderr">,
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCommand({
    ...options,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

describe("runWorkflowCommand watch --events (issue #369)", () => {
  it("prints every ledger event exactly once, ordered by seq, replaying from the start", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "run-events", "complete", 1);
      const audit = new AuditRepository(connection.database);
      audit.append("run-events", { event_type: "leaf.started", node_id: "a", created_at: 1 });
      audit.append("run-events", { event_type: "leaf.completed", node_id: "a", created_at: 2 });
      audit.append("run-events", { event_type: "workflow.done", created_at: 3 });

      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "run-events", events: true },
      });
      expect(result.code).toBe(0);
      for (const eventType of ["leaf.started", "leaf.completed", "workflow.done"])
        expect(result.stdout.match(new RegExp(eventType, "g"))).toHaveLength(1);
      const startedAt = result.stdout.indexOf("leaf.started");
      const completedAt = result.stdout.indexOf("leaf.completed");
      const doneAt = result.stdout.indexOf("workflow.done");
      expect(startedAt).toBeGreaterThanOrEqual(0);
      expect(startedAt).toBeLessThan(completedAt);
      expect(completedAt).toBeLessThan(doneAt);
      // The state line (run id prefix + status) is still there, after the
      // event replay.
      expect(result.stdout).toContain("run-events".slice(0, 8));
    } finally {
      connection.close();
    }
  });

  it("advances the cursor across polls without re-showing an already-printed event", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "run-poll", "running", 1);
      // A live lock row past `now` (100) keeps `isStale` false for the
      // first iteration — this test is about the events cursor, not the
      // stale-run hint.
      connection.database
        .prepare(
          "INSERT INTO workflow_run_locks (run_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run("run-poll", "test-holder", 1, 1_000);
      const audit = new AuditRepository(connection.database);
      audit.append("run-poll", { event_type: "leaf.started", node_id: "a", created_at: 1 });
      let polls = 0;
      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "run-poll", events: true, poll: 0 },
        now: () => 100,
        sleep: (_ms) => {
          polls += 1;
          // A direct write, bypassing putRunState's lease/fence guards on
          // purpose: this test's lock row above exists only to keep the
          // FIRST iteration from reading as stale, not to model a real
          // owned write. Guarded by `polls` so a bug that never flips the
          // row to terminal fails fast instead of hanging the suite.
          if (polls > 5) throw new Error("T369 watch --events poll test looped past 5 iterations");
          audit.append("run-poll", { event_type: "leaf.completed", node_id: "a", created_at: 2 });
          connection.database
            .prepare("UPDATE workflow_run_state SET status=?, updated_at=? WHERE run_id=?")
            .run("complete", 2, "run-poll");
          return Promise.resolve();
        },
      });
      expect(result.code).toBe(0);
      expect(polls).toBe(1);
      expect(result.stdout.match(/leaf\.started/g)).toHaveLength(1);
      expect(result.stdout.match(/leaf\.completed/g)).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  // PR #381 round 2, minor (d): `AuditRepository.query` clamps `limit` to
  // 100 (`audit-repository.ts`), so `drainAuditEvents` must loop across
  // `has_more` pages within ONE watch iteration — a run with more than 100
  // events must still show every one, exactly once.
  it("drains more than one ledger page in a single iteration, every event exactly once", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "run-many", "complete", 1);
      const audit = new AuditRepository(connection.database);
      const total = 150;
      for (let i = 0; i < total; i += 1)
        audit.append("run-many", {
          event_type: "leaf.started",
          node_id: `n${String(i)}`,
          created_at: i,
        });

      const result = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "run-many", events: true },
      });
      expect(result.code).toBe(0);
      const eventLines = result.stdout.split("\n").filter((line) => line.includes("leaf.started"));
      expect(eventLines).toHaveLength(total);
      const nodeIds = eventLines.map((line) => line.trim().split(/\s+/).at(-1));
      expect(new Set(nodeIds).size).toBe(total);
      expect(nodeIds[0]).toBe("n0");
      expect(nodeIds.at(-1)).toBe(`n${String(total - 1)}`);
    } finally {
      connection.close();
    }
  });

  it("without --events, stdout is byte-identical to a plain watch of the same run", async () => {
    const connection = tmpDatabase();
    try {
      insertRun(connection, "run-plain", "complete", 1);
      const audit = new AuditRepository(connection.database);
      audit.append("run-plain", { event_type: "leaf.started", node_id: "a", created_at: 1 });

      const plain = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "run-plain" },
      });
      const withoutEventsFlag = await run({
        action: "watch",
        databasePath: connection.databasePath,
        args: { run_id: "run-plain", events: false },
      });
      expect(withoutEventsFlag).toEqual(plain);
      expect(plain.stdout).not.toContain("leaf.started");
    } finally {
      connection.close();
    }
  });
});
