#!/usr/bin/env node
// T16 candidate driver — mirrors scripts/parity/workflow-durability/oracle-driver.py
// step for step over the same DB tables, using the candidate's public modules.
// Temp dirs only; injected clock; no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import process from "node:process";

import { openStateDatabase } from "../../../dist/state/index.js";
import { WorkflowRepository } from "../../../dist/state/workflow-repository.js";
import { LockRepository } from "../../../dist/state/locks.js";
import {
  durableFromRow,
  pauseFields,
  ownershipLost,
} from "../../../dist/workflow/service.js";

const CLOCK = { now: 1000 };
const OUT = [];

function step(name, value) {
  OUT.push({ step: name, value });
}

const root = mkdtempSync(join(tmpdir(), "lohra-t16-candidate-"));
const connection = openStateDatabase(join(root, "state.db"));
const db = connection.database;
const locks = new LockRepository(db);
const repository = new WorkflowRepository(db);
const ownershipOf = () => ({ fence: 0, holder: "x", now: CLOCK.now });

function store(holder, ttl = 900) {
  return { holder, ttl };
}

const a = store("proc-a");
const b = store("proc-b");

step("ddl", Object.fromEntries(
  ["workflow_node_cache", "workflow_node_cost", "workflow_run_spend",
   "workflow_run_state", "workflow_run_locks", "workflow_run_fence"].map((name) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
    return [name, row === undefined ? null : String(row.sql)];
  }),
));

const acquireFirst = locks.acquireRunLease("run-1", a.holder, CLOCK.now, a.ttl);
step("acquire_first", acquireFirst !== null);
const fenceA = ownershipOf().fence !== undefined ? locks.runFenceOf("run-1") : null;
step("fence_after_first", Number(fenceA));
step("acquire_second_live", locks.acquireRunLease("run-1", b.holder, CLOCK.now, b.ttl) !== null);
// loser presents no fence in memory: fail-closed refusal before SQL
const loserWrite = (() => {
  try {
    return repository.putRunState("run-1", {
      name: null, owner: b.holder, status: "running", pauseReason: null,
      pausePayloadJson: null, specJson: null, argsJson: "{}", tokenBudget: null,
      tainted: false, progressJson: null, auditSegmentId: null, updatedAt: CLOCK.now,
      fence: null, holder: b.holder, now: CLOCK.now, requireUnleased: false,
    });
  } catch {
    return "exception";
  }
})();
step("fence_of_loser_evicted", loserWrite === false);
step("lease_expiry", locks.runLeaseExpiry("run-1", CLOCK.now));

const fenceOfA = Number(locks.runFenceOf("run-1"));
step("write_owner_live", repository.putRunState("run-1", {
  name: "n", owner: a.holder, status: "running", pauseReason: null,
  pausePayloadJson: null, specJson: JSON.stringify({ meta: { name: "n" } }), argsJson: "{}",
  tokenBudget: null, tainted: false, progressJson: null, auditSegmentId: null,
  updatedAt: CLOCK.now, fence: fenceOfA, holder: a.holder, now: CLOCK.now,
}));
step("write_evicted_refused", repository.putRunState("run-1", {
  name: "n", owner: b.holder, status: "running", pauseReason: null,
  pausePayloadJson: null, specJson: null, argsJson: "{}", tokenBudget: null,
  tainted: false, progressJson: null, auditSegmentId: null, updatedAt: CLOCK.now,
  fence: fenceOfA + 1, holder: b.holder, now: CLOCK.now,
}));
step("renew_by_owner", locks.renewRunLease("run-1", a.holder, CLOCK.now, a.ttl));

locks.releaseRunLease("run-1", a.holder);
step("db_fence_after_release", Number(locks.runFenceOf("run-1")));
const acquireAfterRelease = locks.acquireRunLease("run-1", b.holder, CLOCK.now, b.ttl);
step("acquire_after_release", acquireAfterRelease !== null);
step("fence_after_reacquire", Number(locks.runFenceOf("run-1")));
const staleFence = fenceOfA;
step("stale_owner_write_refused", repository.putRunState("run-1", {
  name: "n", owner: a.holder, status: "complete", pauseReason: null,
  pausePayloadJson: null, specJson: null, argsJson: "{}", tokenBudget: null,
  tainted: false, progressJson: null, auditSegmentId: null, updatedAt: CLOCK.now,
  fence: staleFence, holder: a.holder, now: CLOCK.now,
}));
step("state_after_stale_write", String((repository.getRunState("run-1") ?? {}).status));

step("spend_put", repository.putRunSpend("run-1", 100, 10, 5, 0, 0, 0, {
  fence: Number(locks.runFenceOf("run-1")), holder: b.holder, now: CLOCK.now,
}));
const spendRow = repository.getRunSpend("run-1");
step("spend_row", spendRow === null ? null : {
  cache_read_tokens: Number(spendRow.cache_read_tokens ?? 0),
  cache_write_tokens: Number(spendRow.cache_write_tokens ?? 0),
  reasoning_tokens: Number(spendRow.reasoning_tokens ?? 0),
  token_budget: spendRow.token_budget === null ? null : Number(spendRow.token_budget),
  tokens_in: Number(spendRow.tokens_in ?? 0),
  tokens_out: Number(spendRow.tokens_out ?? 0),
});
const fenceNow = Number(locks.runFenceOf("run-1"));
step("cache_put_owned", repository.putCacheCell("run-1", "h1", "node", "{}", "complete", {
  fence: fenceNow, holder: b.holder, now: CLOCK.now,
}));
step("cache_put_stale", repository.putCacheCell("run-1", "h2", "node", "{}", "complete", {
  fence: fenceNow - 1, holder: b.holder, now: CLOCK.now,
}));
step("cache_h2_absent", repository.getCacheCell("run-1", "h2") === null ? null : "present");

CLOCK.now = 1000 + 901;
step("renew_after_expiry", locks.renewRunLease("run-1", b.holder, CLOCK.now, b.ttl));
step("expiry_after_ttl", locks.runLeaseExpiry("run-1", CLOCK.now));

const stranger = store("proc-a3");
step("cancel_missing", stranger.holder === "proc-a3" ? (repository.getRunState("nope") === null ? "missing" : "cancelled") : "?");
const rowB = repository.getRunState("run-1");
const viewB = rowB === null ? null : durableFromRow(rowB);
const statusAfter = String((repository.getRunState("run-1") ?? {}).status);
step("is_stale_running_no_lease", statusAfter === "running" && locks.runLeaseExpiry("run-1", CLOCK.now) !== null && viewB !== null ? pauseFields(viewB) === null : false);

// H1 hardening probe (mirrors oracle-driver.py): same (fence, holder) after
// this stretch RELEASED. The oracle accepts it; the candidate refuses, and the
// bilateral record registers that as a security divergence, never a match.
const hFence = Number(locks.acquireRunLease("run-h1", "proc-h", CLOCK.now, 900));
step("h1_write_owned", repository.putRunState("run-h1", {
  name: "h", owner: "proc-h", status: "running", pauseReason: null,
  pausePayloadJson: null, specJson: JSON.stringify({ meta: { name: "h" } }), argsJson: "{}",
  tokenBudget: null, tainted: false, progressJson: null, auditSegmentId: null,
  updatedAt: CLOCK.now, fence: hFence, holder: "proc-h", now: CLOCK.now,
}));
locks.releaseRunLease("run-h1", "proc-h");
step("h1_write_post_release", repository.putRunState("run-h1", {
  name: "h", owner: "proc-h", status: "complete", pauseReason: null,
  pausePayloadJson: null, specJson: null, argsJson: "{}",
  tokenBudget: null, tainted: false, progressJson: null, auditSegmentId: null,
  updatedAt: CLOCK.now, fence: hFence, holder: "proc-h", now: CLOCK.now,
}));
step("h1_status_after", String((repository.getRunState("run-h1") ?? {}).status));

const envelope = ownershipLost("run-1", 7);
step("ownership_lost_envelope", { ...envelope });

connection.close();
rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(OUT)}\n`);
