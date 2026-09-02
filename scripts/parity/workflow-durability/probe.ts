#!/usr/bin/env node
// T16 deterministic TS probe — heartbeat TTL/3, re-arm, stop on ownership
// loss, zero renew post-release; fenced writes; durable line round-trip.
// Injected timers/clock: nothing sleeps. Complements run-all.ts bilateral.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStateDatabase } from "../../../dist/state/index.js";
import { LockRepository } from "../../../dist/state/locks.js";
import { durableFromRow } from "../../../dist/workflow/service.js";
import { WorkflowRepository } from "../../../dist/state/workflow-repository.js";
import {
  LeaseHeartbeat,
  resumeDelay,
  MIN_RESUME_DELAY,
  MAX_RESUME_DELAY,
  MAX_RESUME_ATTEMPTS,
} from "../../../dist/workflow/durability.js";

const OUT: { readonly step: string; readonly value: unknown }[] = [];
function step(name: string, value: unknown): void {
  OUT.push({ step: name, value });
}

const root = mkdtempSync(join(tmpdir(), "lohra-t16-probe-"));
try {
  const connection = openStateDatabase(join(root, "state.db"));
  const locks = new LockRepository(connection.database);
  const repository = new WorkflowRepository(connection.database);

  // heartbeat TTL/3 with injected timers
  const timers: { delay: number; fire(): void; cancelled: boolean; cancel(): void }[] = [];
  const clock = { owned: true };
  const heartbeat = new LeaseHeartbeat((_runId) => clock.owned, {
    interval: 300,
    timerFactory: (delay, fire) => {
      const timer = {
        delay,
        fire,
        cancelled: false,
        cancel: () => {
          timer.cancelled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
  });
  heartbeat.start("run");
  step("hb_interval_is_ttl_over_3", timers[0]?.delay === 300);
  timers[0]?.fire();
  const pendingBeforeLoss = timers.filter((timer) => !timer.cancelled).at(-1);
  step("hb_rearms_while_owned", pendingBeforeLoss !== undefined);
  clock.owned = false;
  const armedBeforeLoss = timers.length;
  pendingBeforeLoss?.fire();
  step("hb_stops_at_ownership_loss", timers.length === armedBeforeLoss);
  heartbeat.start("run-2");
  const afterStart = timers.length;
  heartbeat.stop("run-2");
  heartbeat.shutdown();
  step("hb_zero_renew_after_release", timers.length === afterStart);

  // autoresume constants and clamping
  step("resume_constants", {
    min: MIN_RESUME_DELAY,
    max: MAX_RESUME_DELAY,
    attempts: MAX_RESUME_ATTEMPTS,
  });
  step("resume_delay_clamps", [resumeDelay(0), resumeDelay(1), resumeDelay(20), resumeDelay(0, 2)]);

  // fenced write refusal matrix over the planted token
  const fence = locks.acquireRunLease("probe", "p1", 1000, 100);
  if (fence === null) throw new Error("probe acquire failed");
  const now = 1000;
  const ownerWrite = repository.putRunState("probe", {
    name: "n",
    owner: "p1",
    status: "running",
    pauseReason: null,
    pausePayloadJson: null,
    specJson: "{}",
    argsJson: "{}",
    tokenBudget: null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: now,
    fence,
    holder: "p1",
    now,
  });
  const staleWrite = repository.putRunState("probe", {
    name: "n",
    owner: "p1",
    status: "complete",
    pauseReason: null,
    pausePayloadJson: null,
    specJson: "{}",
    argsJson: "{}",
    tokenBudget: null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: now,
    fence: fence - 1,
    holder: "p1",
    now,
  });
  const forgedWrite = repository.putRunState("probe", {
    name: "n",
    owner: "p1",
    status: "complete",
    pauseReason: null,
    pausePayloadJson: null,
    specJson: "{}",
    argsJson: "{}",
    tokenBudget: null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: now,
    fence: fence + 1,
    holder: "p1",
    now,
  });
  locks.releaseRunLease("probe", "p1");
  const postReleaseWrite = repository.putRunState("probe", {
    name: "n",
    owner: "p1",
    status: "complete",
    pauseReason: null,
    pausePayloadJson: null,
    specJson: "{}",
    argsJson: "{}",
    tokenBudget: null,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: now,
    fence,
    holder: "p1",
    now,
  });
  step("fence_matrix", { ownerWrite, staleWrite, forgedWrite, postReleaseWrite });

  // durable line round-trip incl. pause payload
  const fence2 = locks.acquireRunLease("paused-run", "p1", 1000, 900);
  if (fence2 === null) throw new Error("probe acquire 2 failed");
  repository.putRunState("paused-run", {
    name: "pr",
    owner: "p1",
    status: "paused",
    pauseReason: "checkpoint",
    pausePayloadJson: JSON.stringify({
      checkpoint: { node_id: "cp1", prompt: "answer" },
      attempts: 2,
    }),
    specJson: "{}",
    argsJson: "{}",
    tokenBudget: 5,
    tainted: true,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: 1000,
    fence: fence2,
    holder: "p1",
    now: 1000,
  });
  const row = repository.getRunState("paused-run");
  const view = row === null ? null : durableFromRow(row);
  step(
    "durable_roundtrip",
    view === null
      ? null
      : {
          status: view.status,
          pause_reason: view.pause_reason,
          checkpoint_node: view.checkpoint?.node_id ?? null,
          attempts: view.attempts,
          tainted: view.tainted,
          token_budget: view.token_budget,
        },
  );

  connection.close();
  process.stdout.write(`${JSON.stringify(OUT)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
