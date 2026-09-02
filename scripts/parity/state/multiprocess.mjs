import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import { LockRepository, openStateDatabase } from "../../../dist/state/index.js";

import {
  cleanEnvironment,
  guardAfter,
  guardBefore,
  parseWorkspace,
  writeEvidence,
} from "./probe-utils.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const nodeWorker = join(projectRoot, "scripts/parity/state/worker.mjs");
const pythonWorker = join(projectRoot, "scripts/parity/state/worker.py");
const timeoutMs = 15_000;
const maxOutputBytes = 16_777_216;

function spawnCaptured(executable, argv, options) {
  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let outputExceeded = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? timeoutMs);
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > maxOutputBytes) {
      outputExceeded = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxOutputBytes) {
      outputExceeded = true;
      child.kill("SIGKILL");
    }
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });
  });
  return { child, done };
}

async function waitFor(predicate, cause, boundMs = 5_000) {
  const deadline = Date.now() + boundMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${cause}: deadline exceeded`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseWorker(result, cause) {
  if (result.timedOut) throw new Error(`${cause}_TIMEOUT`);
  if (result.outputExceeded) throw new Error(`${cause}_OUTPUT_LIMIT`);
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(
      `${cause}: exit=${String(result.exitCode)} signal=${String(result.signal)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function realRace(action, databasePath, root, workspace) {
  const bootstrap = openStateDatabase(databasePath);
  bootstrap.close();
  const barrier = join(root, `${action}-barrier`);
  mkdirSync(barrier, { recursive: true });
  const home = join(root, `${action}-home`);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const environment = cleanEnvironment(home);
  const children = [
    spawnCaptured(workspace.python, [pythonWorker, action, databasePath, barrier, "0", "p0"], {
      cwd: root,
      environment,
    }),
    spawnCaptured(process.execPath, [nodeWorker, action, databasePath, barrier, "1", "p1"], {
      cwd: root,
      environment,
    }),
    spawnCaptured(process.execPath, [nodeWorker, action, databasePath, barrier, "2", "p2"], {
      cwd: root,
      environment,
    }),
  ];
  let rawResults;
  try {
    await waitFor(
      () => [0, 1, 2].every((slot) => existsSync(join(barrier, `ready-${slot}`))),
      "BARRIER_READY_TIMEOUT",
    );
    writeFileSync(join(barrier, "start"), "start\n", "utf8");
    rawResults = await Promise.all(children.map((entry) => entry.done));
  } catch (error) {
    for (const entry of children) entry.child.kill("SIGKILL");
    await Promise.allSettled(children.map((entry) => entry.done));
    throw error;
  }
  const results = rawResults.map((result, index) => ({
    ...parseWorker(result, "RACE_WORKER"),
    index,
  }));
  const winners = results.filter((result) => result.won);
  if (winners.length !== 1) throw new Error(`${action.toUpperCase()}_RACE: expected one winner`);
  if (action === "lease" && winners[0].token !== 1) {
    throw new Error(`LEASE_RACE_FENCE: expected fence 1, received ${String(winners[0].token)}`);
  }
  return {
    raw: results,
    projection: {
      losers: 2,
      outcomes: ["winner", "loser", "loser"],
      winnerFence: action === "lease" ? winners[0].token : null,
      winnerPosition: 0,
      winners: 1,
    },
  };
}

function sequentialFence(path) {
  const connection = openStateDatabase(path);
  const warnings = [];
  const locks = new LockRepository(connection.database, (warning) => warnings.push(warning));
  try {
    const first = locks.acquireRunLease("run-stale", "p1", 10, 1);
    locks.tryWriteProbeRunState("run-stale", "p1", "running", 10, first);
    locks.releaseRunLease("run-stale", "p1");
    const second = locks.acquireRunLease("run-stale", "p2", 11, 1);
    locks.tryWriteProbeRunState("run-stale", "owner-new", "running", 11, second);
    const staleAccepted = locks.tryWriteProbeRunState(
      "run-stale",
      "owner-old",
      "complete",
      12,
      first,
    );
    const row = connection.database
      .prepare("SELECT owner,status FROM workflow_run_state WHERE run_id='run-stale'")
      .get();
    locks.releaseRunLease("run-stale", "p2");
    const third = locks.acquireRunLease("run-stale", "p3", 12, 1);
    locks.releaseRunLease("run-stale", "p3");
    return {
      fences: [first, second, third],
      fenceAfterRelease: locks.runFenceOf("run-stale"),
      row,
      staleAccepted,
      warnings,
    };
  } finally {
    connection.close();
  }
}

async function busyTimeout(path, root) {
  const owner = openStateDatabase(path);
  try {
    owner.database.exec("BEGIN IMMEDIATE");
    const home = join(root, "busy-home");
    mkdirSync(join(home, "tmp"), { recursive: true });
    const child = spawnCaptured(
      process.execPath,
      [nodeWorker, "busy-write", path, root, "0", "busy"],
      {
        cwd: root,
        environment: cleanEnvironment(home),
        timeoutMs: 10_000,
      },
    );
    const raw = parseWorker(await child.done, "BUSY_WORKER");
    const cause = typeof raw.cause === "string" && /database is locked/iu.test(raw.cause);
    const withinWindow = raw.durationMs >= 4_500 && raw.durationMs <= 6_500;
    if (raw.wrote || !cause || !withinWindow) {
      throw new Error(`BUSY_TIMEOUT: ${JSON.stringify(raw)}`);
    }
    return { raw, projection: { cause: "database is locked", withinWindow: true, wrote: false } };
  } finally {
    owner.database.exec("ROLLBACK");
    owner.close();
  }
}

async function crashRecovery(path, root) {
  const bootstrap = openStateDatabase(path);
  bootstrap.close();
  const barrier = join(root, "crash-barrier");
  mkdirSync(barrier, { recursive: true });
  const home = join(root, "crash-home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  const child = spawnCaptured(
    process.execPath,
    [nodeWorker, "crash", path, barrier, "0", "crash"],
    {
      cwd: root,
      environment: cleanEnvironment(home),
    },
  );
  try {
    await waitFor(() => existsSync(join(barrier, "crash-ready")), "CRASH_READY_TIMEOUT");
  } catch (error) {
    child.child.kill("SIGKILL");
    await child.done;
    throw error;
  }
  child.child.kill("SIGKILL");
  const processResult = await child.done;
  if (processResult.signal !== "SIGKILL") {
    throw new Error(`CRASH_SIGNAL: expected SIGKILL, received ${String(processResult.signal)}`);
  }
  const recovered = openStateDatabase(path);
  try {
    const ids = recovered.database.prepare("SELECT id FROM sessions ORDER BY id").pluck().all();
    const quickCheck = recovered.database.pragma("quick_check", { simple: true });
    const journalMode = recovered.database.pragma("journal_mode", { simple: true });
    const projection = {
      committed: ids.includes("committed"),
      journalMode,
      quickCheck,
      uncommitted: ids.includes("uncommitted"),
    };
    if (
      !projection.committed ||
      projection.uncommitted ||
      quickCheck !== "ok" ||
      journalMode !== "wal"
    ) {
      throw new Error(`CRASH_RECOVERY: ${JSON.stringify(projection)}`);
    }
    return { raw: { process: processResult, ids }, projection };
  } finally {
    recovered.close();
  }
}

async function main() {
  const workspace = parseWorkspace(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "lohra-parity-t03-multiprocess-"));
  const scratch = join(root, "guard");
  mkdirSync(scratch, { recursive: true });
  let raw;
  let projection;
  try {
    const before = guardBefore(workspace, scratch);
    const compression = await realRace(
      "compression",
      join(root, "compression.db"),
      root,
      workspace,
    );
    const lease = await realRace("lease", join(root, "lease.db"), root, workspace);
    const sequential = sequentialFence(join(root, "sequential.db"));
    const busy = await busyTimeout(join(root, "busy.db"), root);
    const crash = await crashRecovery(join(root, "crash.db"), root);
    const sidecars = ["crash.db-wal", "crash.db-shm"].map((name) => {
      const path = join(root, name);
      return {
        name,
        exists: existsSync(path),
        size: existsSync(path) ? statSync(path).size : null,
      };
    });
    const after = guardAfter(workspace, scratch);
    projection = {
      busy: busy.projection,
      compression: compression.projection,
      crash: crash.projection,
      guard: { commit: after.commit, clean: after.porcelain === "" },
      lease: lease.projection,
      sequential,
    };
    raw = {
      busy: busy.raw,
      compression: compression.raw,
      crash: crash.raw,
      guardBefore: before,
      guardAfter: after,
      lease: lease.raw,
      root,
      sidecars,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const evidence = writeEvidence(
    projectRoot,
    "t03-multiprocess",
    { ...raw, cleanup: true },
    projection,
  );
  process.stdout.write(
    `${JSON.stringify({ probe: "t03-multiprocess", evidence: evidence.path, projectionSha256: evidence.sha })}\n`,
  );
}

await main();
