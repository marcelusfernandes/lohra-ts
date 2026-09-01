#!/usr/bin/env node
// Planted multi-process scenario (contract G45/G46): three real node
// processes, both phases against ALL write categories.
//   Phase 1 — stale fence F-1 against a live owner.
//   Phase 2 — stale ownership with fence F after release / expiry / wrong holder.
// Refusals must be 100% across executions; removing either guard turns this red.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const WORKER = resolve(import.meta.dirname, "worker.mjs");

function runWorker(workspace, scenario) {
  const result = spawnSync(process.execPath, [WORKER, workspace, scenario], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`worker ${scenario} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const workspace = process.argv[2];
if (workspace === undefined) throw new Error("usage: plant-stale.mjs <workspace>");

const phase1 = runWorker(workspace, "stale-fence");
const phase2 = runWorker(workspace, "stale-ownership");
const phase3 = runWorker(workspace, "expired-lease-new-owner");

const ok =
  phase1.refusals === phase1.attempts &&
  phase2.refusals === phase2.attempts &&
  phase3.refusals === phase3.attempts &&
  phase3.newOwnerWrite === true &&
  phase3.fenceAdvanced === true;

process.stdout.write(`${JSON.stringify({
  ok,
  phases: [
    { name: "stale-fence", ...phase1 },
    { name: "stale-ownership", ...phase2 },
    { name: "expired-lease-new-owner", ...phase3 },
  ],
  processes: 3,
})}\n`);
