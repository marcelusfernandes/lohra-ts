#!/usr/bin/env node
// P1 — the LIVE owner process. It acquires the run lease, announces the fence
// it won, and then STAYS ALIVE holding it: the concurrent writers of
// planted-stale.mjs run against a real second process, not a simulation.
//
//   usage: lease-owner.mjs <db> <runId> <holder> <now> <ttl> <mode>
//   mode=hold  — release + exit when stdin closes (orchestrator's signal)
//   mode=crash — never exit; the orchestrator SIGKILLs it
import process from "node:process";
import { setInterval } from "node:timers";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { LockRepository } from "../../../../dist/state/locks.js";

const [db, runId, holder, now, ttl, mode = "hold"] = process.argv.slice(2);
if (db === undefined || runId === undefined || holder === undefined) {
  throw new Error("usage: lease-owner.mjs <db> <runId> <holder> <now> <ttl> <mode>");
}

const connection = openStateDatabase(db);
const locks = new LockRepository(connection.database);
const fence = locks.acquireRunLease(runId, holder, Number(now), Number(ttl));
if (fence === null) {
  process.stdout.write(`${JSON.stringify({ ready: false, fence: null, pid: process.pid })}\n`);
  connection.close();
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({ ready: true, fence: Number(fence), pid: process.pid })}\n`);

if (mode === "crash") {
  // Hold the lease and never let go: the orchestrator kills this process.
  setInterval(() => undefined, 1_000);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    const released = locks.releaseRunLease(runId, holder);
    process.stdout.write(`${JSON.stringify({ released })}\n`);
    connection.close();
    process.exit(0);
  });
}
