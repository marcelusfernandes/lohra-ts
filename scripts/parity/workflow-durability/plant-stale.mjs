#!/usr/bin/env node
// Planted multi-process evidence (contract 45/46). Every actor here is a real
// OS process against one shared SQLite file, and the conditions are PLANTED
// rather than hoped for (preflight ruling): nothing depends on winning a race.
//
//   A. simultaneous acquire — three racers on one barrier, exactly one winner
//   B. live owner + concurrent writers — P1 holds the lease and stays alive
//      while P2 (stale fence F-1) and P3 (stale ownership) write CONCURRENTLY
//   C. SIGKILL + cold resume — the owner is killed mid-run, a NEW process
//      resumes past the TTL, replays the finished cell, and the corpse's own
//      (fence, holder) pair is refused
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const WORKERS = resolve(import.meta.dirname, "workers");
const OWNER_NOW = 1000;
const OWNER_TTL = 5;

function worker(name, args) {
  return spawn(process.execPath, [join(WORKERS, name), ...args.map(String)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Collect a worker's stdout lines, resolving each JSON line as it arrives. */
function reader(child) {
  const lines = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";
  // Exit is captured EAGERLY: a worker that finishes before we ask must not
  // leave the orchestrator waiting on an event that already fired.
  let exited = null;
  const exitWaiters = [];
  child.once("exit", (code, signal) => {
    exited = { code, signal, stderr };
    while (exitWaiters.length > 0) exitWaiters.shift()(exited);
    for (const waiter of waiters.splice(0)) {
      waiter.reject(
        new Error(`worker exited (code=${String(code)} signal=${String(signal)}): ${stderr}`),
      );
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        const value = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter.resolve(value);
        else lines.push(value);
      }
      index = buffer.indexOf("\n");
    }
  });
  return {
    next: () =>
      new Promise((resolveLine, rejectLine) => {
        const ready = lines.shift();
        if (ready !== undefined) {
          resolveLine(ready);
          return;
        }
        if (exited !== null) {
          rejectLine(
            new Error(
              `worker exited (code=${String(exited.code)} signal=${String(exited.signal)}): ${stderr}`,
            ),
          );
          return;
        }
        waiters.push({ resolve: resolveLine, reject: rejectLine });
      }),
    exit: () =>
      new Promise((resolveExit) => {
        if (exited !== null) {
          resolveExit(exited);
          return;
        }
        exitWaiters.push(resolveExit);
      }),
    stderr: () => stderr,
  };
}

const workspace = process.argv[2];
if (workspace === undefined) throw new Error("usage: plant-stale.mjs <workspace>");
const root = join(workspace, "plant-scenario");
mkdirSync(root, { recursive: true });
const db = join(root, "state.db");

// --- A. simultaneous acquire: exactly one winner --------------------------
const barrier = join(root, "barrier");
writeFileSync(barrier, "wait", "utf8");
const racers = ["r1", "r2", "r3"].map((holder) => {
  const child = worker("racer.mjs", [db, "raced", holder, barrier, OWNER_NOW, 900]);
  return { holder, child, io: reader(child) };
});
// every racer must be armed (connection open, spinning) before the start signal
await Promise.all(racers.map(async (racer) => racer.io.next()));
rmSync(barrier, { force: true });
const raceResults = await Promise.all(racers.map(async (racer) => racer.io.next()));
await Promise.all(racers.map(async (racer) => racer.io.exit()));
const winners = raceResults.filter((result) => result.won);
// The RECORD carries the shape, never the identities: which racer won and what
// pid it ran under are OS-scheduling facts, and a digest that moves every run
// is not reproducible evidence. The identities go to stderr for a human.
const race = {
  processes: racers.length,
  contenders: racers.map((racer) => racer.holder).sort(),
  winners: winners.length,
  winnerFenceIsFirst: winners.every((result) => result.fence === 1),
  losersCarryNoFence: raceResults
    .filter((result) => !result.won)
    .every((result) => result.fence === null),
  distinctPids: new Set(raceResults.map((result) => result.pid)).size === racers.length,
};

// --- B. live owner + CONCURRENT planted writers ---------------------------
const owner = worker("lease-owner.mjs", [db, "planted", "p1", OWNER_NOW, 900, "hold"]);
const ownerIo = reader(owner);
const ownerReady = await ownerIo.next();
if (ownerReady.ready !== true) throw new Error("P1 failed to acquire the lease");
// P1 is alive and holding while P2/P3 run: assert liveness, not assume it.
const ownerAlive = (() => {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
})();
const writers = [
  // P2 — phase 1: stale fence F-1, honest holder, live lease
  worker("planted-writer.mjs", [
    db,
    "planted",
    "stale-fence",
    ownerReady.fence - 1,
    "p1",
    OWNER_NOW + 1,
  ]),
  // P3 — phase 2: fence exactly current, WRONG holder, live lease
  worker("planted-writer.mjs", [
    db,
    "planted",
    "wrong-holder",
    ownerReady.fence,
    "p2",
    OWNER_NOW + 1,
  ]),
];
const writerIo = writers.map((child) => reader(child));
const concurrent = await Promise.all(writerIo.map(async (io) => io.next()));
await Promise.all(writerIo.map(async (io) => io.exit()));
owner.stdin.end();
const ownerReleased = await ownerIo.next();
await ownerIo.exit();

// phase 2 continued, in its own process: fence current, holder current, but
// the lease is GONE (post-release) — the hardening the oracle does not do.
const afterRelease = worker("planted-writer.mjs", [
  db,
  "planted",
  "post-release",
  ownerReady.fence,
  "p1",
  OWNER_NOW + 2,
]);
const afterReleaseIo = reader(afterRelease);
const postRelease = await afterReleaseIo.next();
await afterReleaseIo.exit();

const plantedPhases = [...concurrent, postRelease];
const liveOwner = {
  ownerFence: ownerReady.fence,
  ownerAliveDuringWrites: ownerAlive,
  ownerReleased: ownerReleased.released === true,
  concurrentWriters: writers.length,
  writersRanInDistinctProcesses:
    new Set([ownerReady.pid, ...plantedPhases.map((phase) => phase.pid)]).size ===
    plantedPhases.length + 1,
  phases: plantedPhases.map((phase) => ({
    phase: phase.phase,
    attempts: phase.attempts,
    refusals: phase.refusals,
    landed: phase.landed,
  })),
  allRefused: plantedPhases.every(
    (phase) => phase.refusals === phase.attempts && phase.landed.length === 0,
  ),
};

// --- C. SIGKILL the owner, resume in a NEW process ------------------------
const dying = worker("durable-owner.mjs", [db, "killed", "owner", OWNER_NOW, OWNER_TTL]);
const dyingIo = reader(dying);
const landed = await dyingIo.next();
if (landed.cellLanded !== true) throw new Error("durable owner never landed its first cell");
dying.kill("SIGKILL");
const killed = await dyingIo.exit();

const resumer = worker("cold-resumer.mjs", [
  db,
  "killed",
  "resumer",
  OWNER_NOW + OWNER_TTL + 1,
  900,
  landed.fence,
  "owner",
]);
const resumerIo = reader(resumer);
const resumeResult = await resumerIo.next();
await resumerIo.exit();

// The leaves of the killed owner really ran tools through the sandbox the
// service installed for THAT acquisition: inside its own scratch root allowed,
// outside every root denied with the exact sentence.
const sandboxEnforced =
  Array.isArray(landed.leafToolOutcomes) &&
  landed.leafToolOutcomes.length > 0 &&
  landed.leafToolOutcomes.every(
    (outcome) =>
      outcome.inside === "allowed:write_file" &&
      outcome.outside === "ERROR: path is outside the workflow working scope (sandbox denied)",
  ) &&
  JSON.stringify(landed.sandboxInstalledFences) === JSON.stringify([landed.fence]);

const resumeSandboxEnforced =
  Array.isArray(resumeResult.leafToolOutcomes) &&
  resumeResult.leafToolOutcomes.length > 0 &&
  resumeResult.leafToolOutcomes.every(
    (outcome) =>
      outcome.inside === "allowed:write_file" &&
      // the DEAD acquisition's working root is not this one's
      outcome.deadStretchRoot ===
        "ERROR: path is outside the workflow working scope (sandbox denied)",
  );

const crash = {
  sandboxEnforced,
  resumeSandboxEnforced,
  installedFences: landed.sandboxInstalledFences,
  killedSignal: killed.signal,
  killedFence: landed.fence,
  resumerIsANewProcess: resumeResult.pid !== landed.pid,
  fenceAdvanced: resumeResult.fenceAfter === landed.fence + 1,
  statusBefore: resumeResult.statusBefore,
  status: resumeResult.status,
  // 'a' replayed from its durable cell — only the in-flight 'b' re-executed
  respawned: resumeResult.spawned,
  incompleteOnly: !resumeResult.spawned.includes("a") && resumeResult.spawned.includes("b"),
  recoveredFault: [...resumeResult.faults, ...resumeResult.lineFaults].some((fault) =>
    fault.includes("recovered after process loss"),
  ),
  lateWriteRefused: resumeResult.lateWriteRefused === true,
};

process.stderr.write(
  `${JSON.stringify({
    witness: {
      racePids: raceResults.map((result) => ({
        holder: result.holder,
        pid: result.pid,
        won: result.won,
      })),
      ownerPid: ownerReady.pid,
      writerPids: plantedPhases.map((phase) => phase.pid),
      killedPid: landed.pid,
      resumerPid: resumeResult.pid,
    },
  })}\n`,
);

const ok =
  race.winners === 1 &&
  race.distinctPids &&
  race.winnerFenceIsFirst &&
  liveOwner.writersRanInDistinctProcesses &&
  crash.resumerIsANewProcess &&
  crash.sandboxEnforced &&
  crash.resumeSandboxEnforced &&
  race.losersCarryNoFence &&
  liveOwner.ownerAliveDuringWrites &&
  liveOwner.allRefused &&
  liveOwner.ownerReleased &&
  killed.signal === "SIGKILL" &&
  crash.fenceAdvanced &&
  crash.incompleteOnly &&
  crash.recoveredFault &&
  crash.lateWriteRefused &&
  crash.status === "complete";

process.stdout.write(`${JSON.stringify({ ok, race, liveOwner, crash, processes: 3 })}\n`);
