#!/usr/bin/env node
// One of the three planted-scenario processes. Each invocation is a separate
// OS process competing over the same SQLite file: P1 acquires and holds,
// P2/P3 present planted tokens and must be refused in every category.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import process from "node:process";

import { openStateDatabase } from "../../../dist/state/index.js";
import { LockRepository } from "../../../dist/state/locks.js";
import { WorkflowRepository } from "../../../dist/state/workflow-repository.js";

const workspace = process.argv[2];
if (workspace === undefined) throw new Error("usage: worker.mjs <workspace> <scenario>");
const scenario = process.argv[3] ?? "stale-fence";

const workspaceRoot = join(workspace, "plant-scenario");
mkdirSync(workspaceRoot, { recursive: true });
const connection = openStateDatabase(join(workspaceRoot, "state.db"));
const locks = new LockRepository(connection.database);
const repository = new WorkflowRepository(connection.database);

function attempts(fence, holder, now, runId = "planted") {
  return [
    { category: "state", run: () => repository.putRunState(runId, {
      name: "p", owner: holder, status: "complete", pauseReason: null, pausePayloadJson: null,
      specJson: "{}", argsJson: "{}", tokenBudget: null, tainted: false, progressJson: null,
      auditSegmentId: null, updatedAt: now, fence, holder, now,
    }) },
    { category: "cache", run: () => repository.putCacheCell(runId, "ph", "node", "{}", "complete", { fence, holder, now }) },
    { category: "node-cost", run: () => repository.putCacheCost(runId, "ph", 1, 1, 0, 0, 0, { fence, holder, now }) },
    { category: "spend", run: () => repository.putRunSpend(runId, 10, 1, 1, 0, 0, 0, { fence, holder, now }) },
  ];
}

if (scenario === "stale-fence") {
  // P1 acquires fence F and holds. P2 presents F-1.
  const fence = locks.acquireRunLease("planted", "p1", 1000, 900);
  if (fence === null) throw new Error("p1 failed to acquire");
  const stale = attempts(fence - 1, "p2", 1001);
  const refusals = stale.filter((attempt) => attempt.run() === false).length;
  const rowsLeft = repository.getCacheCell("planted", "ph") === null &&
    repository.getRunSpend("planted") === null;
  connection.close();
  process.stdout.write(`${JSON.stringify({ attempts: stale.length, refusals, nothingWritten: rowsLeft })}\n`);
} else if (scenario === "stale-ownership") {
  // P1 acquires fence F, releases. P3 presents the now-orphaned (fence F,
  // holder p1) pair: post-release ownership must be refused.
  const fence = locks.acquireRunLease("released", "p1", 1000, 900);
  if (fence === null) throw new Error("p1 failed to acquire");
  locks.releaseRunLease("released", "p1");
  const orphaned = attempts(fence, "p1", 1001, "released");
  const refusals = orphaned.filter((attempt) => attempt.run() === false).length;
  connection.close();
  process.stdout.write(`${JSON.stringify({ attempts: orphaned.length, refusals })}\n`);
} else if (scenario === "expired-lease-new-owner") {
  // The stretch's lease expires (TTL passes), a new owner acquires (fence
  // advances), and the new owner's writes land while the dead stretch's
  // planted token is refused.
  const fence = locks.acquireRunLease("expired", "p1", 1000, 50);
  if (fence === null) throw new Error("p1 failed to acquire");
  connection.database
    .prepare("UPDATE workflow_run_locks SET expires_at = 900 WHERE run_id = 'expired'")
    .run();
  const newFence = locks.acquireRunLease("expired", "p2", 1051, 900);
  if (newFence === null || newFence !== fence + 1) throw new Error("fence did not advance");
  const deadStretch = attempts(fence, "p1", 1052, "expired");
  const refusals = deadStretch.filter((attempt) => attempt.run() === false).length;
  const newOwnerWrite = repository.putRunState("expired", {
    name: "e", owner: "p2", status: "running", pauseReason: null, pausePayloadJson: null,
    specJson: "{}", argsJson: "{}", tokenBudget: null, tainted: false, progressJson: null,
    auditSegmentId: null, updatedAt: 1052, fence: newFence, holder: "p2", now: 1052,
  });
  connection.close();
  process.stdout.write(`${JSON.stringify({ attempts: deadStretch.length, refusals, newOwnerWrite, fenceAdvanced: newFence === fence + 1 })}\n`);
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
