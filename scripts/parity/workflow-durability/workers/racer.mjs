#!/usr/bin/env node
// A racer in the SIMULTANEOUS acquire: three of these sit on the same barrier
// file and all call acquireRunLease the moment it disappears. Exactly one may
// come back with a fence; a fence that leaked to a loser is a red run.
//
//   usage: racer.mjs <db> <runId> <holder> <barrier> <now> <ttl>
import { existsSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { LockRepository } from "../../../../dist/state/locks.js";

const [db, runId, holder, barrier, now, ttl] = process.argv.slice(2);
if (db === undefined || runId === undefined || holder === undefined || barrier === undefined) {
  throw new Error("usage: racer.mjs <db> <runId> <holder> <barrier> <now> <ttl>");
}

const connection = openStateDatabase(db);
const locks = new LockRepository(connection.database);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Announce readiness, then spin on the barrier: every racer is already inside
// the SQLite connection when the start signal lands.
process.stdout.write(`${JSON.stringify({ armed: true, holder, pid: process.pid })}\n`);
const deadline = Date.now() + 30_000;
while (existsSync(barrier)) {
  if (Date.now() > deadline) throw new Error("barrier never dropped");
  await sleep(2);
}

const fence = locks.acquireRunLease(runId, holder, Number(now), Number(ttl));
const fenceRow = locks.runFenceOf(runId);
connection.close();
process.stdout.write(
  `${JSON.stringify({
    holder,
    pid: process.pid,
    won: fence !== null,
    fence: fence === null ? null : Number(fence),
    fenceRow: fenceRow === null ? null : Number(fenceRow),
  })}\n`,
);
