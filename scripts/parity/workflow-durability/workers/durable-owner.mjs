#!/usr/bin/env node
// The process that DIES. It runs a real WorkflowService against the shared
// SQLite file: node 'a' completes and its cell lands under the lease, node 'b'
// never returns. Once 'a' is durable it announces itself and hangs, so the
// orchestrator can SIGKILL an owner that genuinely holds a live lease with
// half a run finished.
//
//   usage: durable-owner.mjs <db> <runId> <holder> <now> <ttl>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { LockRepository } from "../../../../dist/state/locks.js";
import { WorkflowRepository } from "../../../../dist/state/workflow-repository.js";
import { WorkflowService } from "../../../../dist/workflow/service.js";

const [db, runId, holder, now, ttl] = process.argv.slice(2);
if (db === undefined || runId === undefined || holder === undefined) {
  throw new Error("usage: durable-owner.mjs <db> <runId> <holder> <now> <ttl>");
}

const connection = openStateDatabase(db);
const repository = new WorkflowRepository(connection.database);
const locks = new LockRepository(connection.database);
const clock = { now: Number(now) };
const workspaceOutside = mkdtempSync(join(tmpdir(), "lohra-t16-outside-"));


/**
 * The evidence runtime really sandboxes its leaves: one installation per
 * acquisition (keyed by fence), and the leaf's tool calls go through the
 * wrapper the service installed for that acquisition. A no-op here would prove
 * nothing, so the leaf below actually runs tools and the outcomes are reported.
 */
function leafSandboxSupport() {
  const installed = new Map();
  const disposed = [];
  const observed = [];
  const base = (name, args) => {
    observed.push({ name, allowed: true, path: args.path ?? null });
    return `allowed:${name}`;
  };
  return {
    install(installation) {
      installed.set(installation.fence, installation.wrap(base));
      return {
        dispose: () => {
          installed.delete(installation.fence);
          disposed.push(installation.fence);
        },
      };
    },
    runLeafTool(fence, name, args) {
      const dispatch = installed.get(fence);
      if (dispatch === undefined) return "NO-SANDBOX-INSTALLED";
      const out = dispatch(name, args);
      if (out.startsWith("ERROR: ")) observed.push({ name, allowed: false, denial: out });
      return out;
    },
    installedFences: () => [...installed.keys()],
    disposedFences: () => [...disposed],
    observed: () => observed,
  };
}

const sandbox = leafSandboxSupport();
const leafToolOutcomes = [];
const nodeOfLeaf = new Map();
let leafSeq = 0;
const runtime = {
  installLeafSandbox: (installation) => sandbox.install(installation),
  spawn(request) {
    leafSeq += 1;
    const id = `leaf-${String(leafSeq)}`;
    nodeOfLeaf.set(id, request.causalContext.nodePath.at(-1) ?? "");
    // The leaf really runs tools, through the wrapper installed for the
    // acquisition that owns this run: one inside its scratch root, one outside.
    const fence = Number(locks.runFenceOf(runId) ?? -1);
    const root = service.workingRootFor(runId);
    leafToolOutcomes.push({
      inside: sandbox.runLeafTool(fence, "write_file", { path: join(root, "leaf.txt") }),
      outside: sandbox.runLeafTool(fence, "read_file", { path: join(workspaceOutside, "secret.txt") }),
    });
    return id;
  },
  collect(id) {
    if (nodeOfLeaf.get(id) === "b") {
      // node 'b' never comes back: the process is killed mid-run
      return new Promise(() => undefined);
    }
    return {
      status: "complete",
      output: { answer: "a-done" },
      usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    };
  },
  steer: () => undefined,
  cancel: () => undefined,
};

const service = new WorkflowService({
  runtime,
  // no live timers: this process is killed, it must not linger on its own
  timerFactory: () => ({ cancel: () => undefined }),
  idSource: () => runId,
  store: {
    repository,
    locks,
    holder,
    ttl: Number(ttl),
    ownershipOf: () => ({ fence: 0, holder, now: clock.now }),
    database: connection.database,
  },
});

const started = service.start({
  meta: { name: "crashy" },
  nodes: [
    { id: "a", type: "agent", prompt: "first" },
    { id: "b", type: "agent", prompt: "second ${a.answer}" },
  ],
});
if ("error" in started) throw new Error(started.error);

// Announce only once node 'a' is durable AND the lease is still ours.
const timer = setInterval(() => {
  const cells = connection.database
    .prepare("SELECT count(*) AS n FROM workflow_node_cache WHERE run_id = ?")
    .get(runId);
  if (Number(cells.n) === 0) return;
  clearInterval(timer);
  const fence = locks.runFenceOf(runId);
  process.stdout.write(
    `${JSON.stringify({
      cellLanded: true,
      pid: process.pid,
      runId,
      fence: fence === null ? null : Number(fence),
      leaseExpiry: locks.runLeaseExpiry(runId, clock.now),
      sandboxInstalledFences: sandbox.installedFences(),
      leafToolOutcomes,
    })}\n`,
  );
  // hold the lease and the half-finished run open until we are killed
  setInterval(() => undefined, 1_000);
}, 5);
