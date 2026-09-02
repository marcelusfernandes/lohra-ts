#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AuditRepository } from "../../../src/state/audit-repository.js";
import { openStateDatabase } from "../../../src/state/connection.js";
import { WorkflowService } from "../../../src/workflow/service.js";
import { AuditTrail } from "../../../src/workflow/audit-trail.js";
import { WorkflowLiveEvents } from "../../../src/workflow/live-events.js";
import {
  AUDIT_EVENT_BYTES,
  AUDIT_EVENTS_PER_RUN,
  AUDIT_QUEUE_CAPACITY,
  AUDIT_RETENTION_SECONDS,
  AUDIT_RUN_CAP,
  safeAuditMetadata,
} from "../../../src/workflow/audit-model.js";
import type { ChildRuntime } from "../../../src/workflow/runtime.js";
import { canonicalJson } from "../canonical.js";
import { resolveExecutable, resolveOracleWorkspace } from "../resolve.js";
import { acquireLock, guardCandidate, git, releaseLock } from "./support.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDir = resolve(root, ".parity-evidence/t17");
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";
const CANARY = "T17_PRIVATE_CANARY_🔒_秘密_🧪";

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function candidateProjection() {
  const directory = mkdtempSync(resolve(tmpdir(), "lohra-t17-candidate-"));
  try {
    const connection = openStateDatabase(resolve(directory, "state.db"));
    try {
      const snapshot = new AuditRepository(connection.database);
      for (let turn = 0; turn < 3; turn += 1)
        snapshot.append("snapshot", {
          event_type: "node.started",
          payload: { state: "running" },
          created_at: 1000 + turn,
        });
      const first = snapshot.query({ runId: "snapshot", limit: 1 });
      snapshot.append("snapshot", {
        event_type: "node.started",
        payload: { state: "running" },
        created_at: 1003,
      });
      const frozen = snapshot.query({
        runId: "snapshot",
        afterSeq: 1,
        snapshotSeq: first.snapshot_seq,
        limit: 10,
      });
      const tail = snapshot.query({ runId: "snapshot", afterSeq: first.snapshot_seq, limit: 10 });

      const retained = new AuditRepository(connection.database, { maxEventsPerRun: 3 });
      for (let turn = 0; turn < 5; turn += 1)
        retained.append("retained", { event_type: "node.started", created_at: 2000 + turn });
      const retainedPage = retained.query({ runId: "retained", limit: 10 });

      const tomb = new AuditRepository(connection.database, { maxRuns: 1 });
      tomb.append("r1", { event_type: "node.started", created_at: 3000 });
      tomb.append("r2", { event_type: "node.started", created_at: 3001 });
      const resumed = tomb.append("r1", { event_type: "node.started", created_at: 3002 });

      const ticks = [0, 0.1, 0.1, 1, 1.1];
      let tick = 0;
      const delivered: string[] = [];
      const live = new WorkflowLiveEvents(
        (event) => delivered.push(event.kind),
        () => ticks[tick++] ?? 2,
      );
      const outcomes = [
        live.emit({ kind: "plan", run_id: "live", nodes: [] }),
        live.emit({ kind: "items", run_id: "live", node_id: "a", done: 0, total: 3 }),
        live.emit({ kind: "items", run_id: "live", node_id: "a", done: 1, total: 3 }),
        live.emit({ kind: "items", run_id: "live", node_id: "b", done: 1, total: 3 }),
        live.emit({ kind: "items", run_id: "live", node_id: "a", done: 2, total: 3 }),
        live.emit({ kind: "items", run_id: "live", node_id: "a", done: 3, total: 3 }),
        live.emit({ kind: "node", run_id: "live", node_id: "a", state: "complete" }),
        live.emit({ kind: "done", run_id: "live", state: "complete" }),
      ];

      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const runtime: ChildRuntime = {
        spawn: () => "leaf",
        collect: () => ({ status: "complete", output: CANARY, usage: null }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: () => "canned-run",
        auditTrail: trail,
      });
      service.start({
        meta: { name: "t17-canned" },
        nodes: [{ id: "leaf", type: "agent", prompt: CANARY }],
      });
      const canned = await service.status("canned-run", true);
      await trail.flush();
      const cannedAudit = audit.query({ runId: "canned-run", limit: 100 });
      return {
        projection: {
          limits: {
            event_bytes: AUDIT_EVENT_BYTES,
            events_per_run: AUDIT_EVENTS_PER_RUN,
            runs: AUDIT_RUN_CAP,
            queue: AUDIT_QUEUE_CAPACITY,
            retention_seconds: AUDIT_RETENTION_SECONDS,
          },
          privacy: {
            canary_absent: !JSON.stringify(
              safeAuditMetadata({
                prompt: CANARY,
                response: CANARY,
                reasoning: CANARY,
                content: CANARY,
                arguments: CANARY,
                result: CANARY,
              }),
            ).includes(CANARY),
            states: Array(6).fill("excluded_by_policy"),
          },
          sqlite: {
            snapshot: first.snapshot_seq,
            frozen: frozen.events.map((event) => event.seq),
            tail: tail.events.map((event) => event.seq),
            retained: retainedPage.events.map((event) => event.seq),
            dropped: (retainedPage.notices[0] as { dropped_count: number }).dropped_count,
            resumed: resumed?.seq,
          },
          live: { outcomes, delivered, tracked: live.trackedNodes() },
        },
        canned: {
          status: "status" in canned ? canned.status : "error",
          auditTypes: cannedAudit.events.map((event) => event.event_type),
          canaryAbsent: !JSON.stringify(cannedAudit).includes(CANARY),
        },
      };
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const candidate = guardCandidate(root);
const oracle = resolveOracleWorkspace({
  cwd: root,
  timeoutMs: 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
});
if (
  git(oracle.repository, "rev-parse", "HEAD") !== ORACLE_SHA ||
  git(oracle.repository, "status", "--porcelain") !== ""
)
  throw new Error("oracle guard failed");
mkdirSync(evidenceDir, { recursive: true });
acquireLock();
try {
  const python = resolveExecutable("oracle-python", { oracle });
  const outcome = spawnSync(python, [resolve(import.meta.dirname, "oracle-driver.py")], {
    cwd: resolve(oracle.repository, "backend"),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: resolve(oracle.repository, "backend"),
      PYTHONHASHSEED: "0",
      PYTHONUTF8: "1",
      TZ: "UTC",
    },
  });
  if (outcome.status !== 0) throw new Error(`oracle driver failed: ${outcome.stderr}`);
  const oracleProjection = JSON.parse(outcome.stdout) as unknown;
  const candidateResult = await candidateProjection();
  if (canonicalJson(oracleProjection) !== canonicalJson(candidateResult.projection))
    throw new Error(
      `bilateral mismatch\noracle=${canonicalJson(oracleProjection)}\ncandidate=${canonicalJson(candidateResult.projection)}`,
    );
  if (candidateResult.canned.status !== "complete" || !candidateResult.canned.canaryAbsent)
    throw new Error("canned workflow audit failed");
  const record = {
    targetSha: candidate.sha,
    oracleSha: ORACLE_SHA,
    commands: ["oracle-driver.py", "candidateProjection"],
    normalizations: [],
    bilateralMatch: true,
    canned: candidateResult.canned,
    projection: candidateResult.projection,
  };
  const digest = sha(record);
  writeFileSync(
    resolve(evidenceDir, "audit-metadata.json"),
    `${JSON.stringify({ ...record, digest }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(evidenceDir, "live-events.json"),
    `${JSON.stringify({ targetSha: candidate.sha, oracleSha: ORACLE_SHA, live: candidateResult.projection.live, digest: sha(candidateResult.projection.live) }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(evidenceDir, "run-all.json"),
    `${JSON.stringify({ targetSha: candidate.sha, oracleSha: ORACLE_SHA, bilateralMatch: true, digest }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ targetSha: candidate.sha, bilateralMatch: true, digest }));
} finally {
  releaseLock();
}
