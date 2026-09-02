import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";

import { LockRepository, openStateDatabase, SessionRepository } from "../../../dist/state/index.js";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForGate(root, slot) {
  writeFileSync(join(root, `ready-${slot}`), "ready\n", "utf8");
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(root, "start"))) {
    if (Date.now() >= deadline) throw new Error("BARRIER_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function race(action, path, barrier, slot, holder) {
  const connection = openStateDatabase(path);
  try {
    const locks = new LockRepository(connection.database);
    await waitForGate(barrier, slot);
    const token =
      action === "compression"
        ? locks.acquireCompressionLock("race", holder, Date.now() / 1000, 60)
        : locks.acquireRunLease("race", holder, 100, 60);
    emit({ runtime: "typescript", slot, won: token !== false && token !== null, token });
  } finally {
    connection.close();
  }
}

function busyWrite(path) {
  const started = Date.now();
  try {
    const connection = openStateDatabase(path);
    try {
      new SessionRepository(connection.database).createSession({ id: "busy", startedAt: 1 });
    } finally {
      connection.close();
    }
    emit({ cause: null, durationMs: Date.now() - started, wrote: true });
  } catch (error) {
    emit({
      cause: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      wrote: false,
    });
  }
}

function crash(path, barrier) {
  const connection = openStateDatabase(path);
  const repo = new SessionRepository(connection.database);
  repo.createSession({ id: "committed", startedAt: 1 });
  connection.database.exec("BEGIN IMMEDIATE");
  connection.database
    .prepare("INSERT INTO sessions (id,source,started_at) VALUES ('uncommitted','cli',2.0)")
    .run();
  writeFileSync(join(barrier, "crash-ready"), "ready\n", "utf8");
  setInterval(() => undefined, 1_000);
}

const [action, path, barrier, slotText, holder] = process.argv.slice(2);
if (action === "compression" || action === "lease") {
  await race(action, path, barrier, Number(slotText), holder);
} else if (action === "busy-write") {
  busyWrite(path);
} else if (action === "crash") {
  crash(path, barrier);
} else {
  throw new Error(`unknown state worker action: ${action}`);
}
