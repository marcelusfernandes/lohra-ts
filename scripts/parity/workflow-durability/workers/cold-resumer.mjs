#!/usr/bin/env node
// The NEW process that picks up after the SIGKILL. Its clock is past the dead
// owner's TTL, so it acquires (fence advances), replays the completed cell
// without respawning it, re-executes only what was in flight, and carries the
// RECOVERED_FAULT. Then it plants the dead stretch's own (fence, holder) pair
// and proves the corpse can no longer write.
//
//   usage: cold-resumer.mjs <db> <runId> <holder> <now> <ttl> <deadFence> <deadHolder>
import process from "node:process";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { LockRepository } from "../../../../dist/state/locks.js";
import { WorkflowRepository } from "../../../../dist/state/workflow-repository.js";
import { WorkflowService } from "../../../../dist/workflow/service.js";

const [db, runId, holder, now, ttl, deadFence, deadHolder] = process.argv.slice(2);
if (db === undefined || runId === undefined || holder === undefined) {
  throw new Error("usage: cold-resumer.mjs <db> <runId> <holder> <now> <ttl> <deadFence> <deadHolder>");
}

const connection = openStateDatabase(db);
const repository = new WorkflowRepository(connection.database);
const locks = new LockRepository(connection.database);
const clock = { now: Number(now) };
const spawned = [];

const runtime = {
  spawn(request) {
    const node = request.causalContext.nodePath.at(-1) ?? "";
    spawned.push(node);
    return `leaf-${node}`;
  },
  collect: () => ({
    status: "complete",
    output: { answer: "b-done" },
    usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }),
  steer: () => undefined,
  cancel: () => undefined,
};

const before = repository.getRunState(runId) ?? {};
const service = new WorkflowService({
  runtime,
  timerFactory: () => ({ cancel: () => undefined }),
  store: {
    repository,
    locks,
    holder,
    ttl: Number(ttl),
    ownershipOf: () => ({ fence: 0, holder, now: clock.now }),
    database: connection.database,
  },
});

const resumed = service.start(null, {}, { resumeRunId: runId });
if ("error" in resumed) {
  process.stdout.write(`${JSON.stringify({ resumed: false, error: resumed.error })}\n`);
  connection.close();
  process.exit(3);
}
const result = await service.status(runId, true);
const fenceAfter = locks.runFenceOf(runId);

// The dead stretch's own honest token, presented late: refused in every category.
const corpse = { fence: Number(deadFence), holder: deadHolder, now: clock.now };
const lateWrites = {
  state: repository.putRunState(runId, {
    name: "corpse", owner: deadHolder, status: "zombie", pauseReason: null,
    pausePayloadJson: null, specJson: "{}", argsJson: "{}", tokenBudget: null,
    tainted: false, progressJson: null, auditSegmentId: null,
    updatedAt: clock.now, fence: corpse.fence, holder: deadHolder, now: clock.now,
  }),
  cache: repository.putCacheCell(runId, "corpse", "node", "{}", "complete", corpse),
  nodeCost: repository.putCacheCost(runId, "corpse", 1, 1, 0, 0, 0, corpse),
  spend: repository.putRunSpend(runId, 1, 1, 1, 0, 0, 0, corpse),
};

const line = repository.getRunState(runId) ?? {};
// The RECOVERED_FAULT rides on the DURABLE line (what workflow_status rolls up
// as faults_total), not only on the in-process result view.
const payload = (() => {
  try { return JSON.parse(String(line.pause_payload_json ?? "{}")); } catch { return {}; }
})();
const lineFaults = Array.isArray(payload.prior_faults) ? payload.prior_faults.map(String) : [];
connection.close();

process.stdout.write(
  `${JSON.stringify({
    resumed: true,
    pid: process.pid,
    statusBefore: String(before.status ?? ""),
    status: String(result.status ?? ""),
    fenceAfter: fenceAfter === null ? null : Number(fenceAfter),
    // 'a' replayed from its durable cell; only the in-flight 'b' re-executed
    spawned,
    faults: Array.isArray(result.faults) ? result.faults : [],
    lineFaults,
    lateWrites,
    lateWriteRefused: Object.values(lateWrites).every((landed) => landed === false),
    finalStatus: String(line.status ?? ""),
  })}\n`,
);
