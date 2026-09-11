// Issue #368: `segment.started`/`segment.completed` bracket one ACQUISITION
// (`audit-producers.ts`'s `announceSegmentStarted`/`announceSegmentCompleted`,
// combined into `announceStretchStart`/`announceStretchEnd` at the two
// `service.ts` call sites). `node.paused` names the pause reason once per
// pause. A dead-owner resume closes the PRIOR segment as
// `interrupted`/`process_crash` under the NEW fence, followed by
// `audit.gap{reason:process_crash}` — distinct from `audit.gap{reason:
// sink_failure}` (audit-trail.ts).
//
// Deliberately built through `WorkflowService` + a real sqlite-backed
// `AuditRepository`/`WorkflowRepository`/`AuditTrail`, not through
// `audit-producers.ts` directly. RED on `main` decf7745: `segment.*` and
// `node.paused` are in the allow-list (`audit-model.ts`) but no producer
// ever emits them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 2,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

function completingRuntime(): ChildRuntime {
  let seq = 0;
  return withMinimalLeafSandbox({
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

/** A single leaf that stays in flight until `release()` — the window
 * `shutdown()` needs to observe the run as not-yet-settled. */
function gatedRuntime(): ChildRuntime & { release(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return withMinimalLeafSandbox({
    spawn: (): string => "leaf-1",
    collect: async (): Promise<ChildResult> => {
      await gate;
      return { status: "complete", output: { ok: true }, usage: USAGE };
    },
    steer: () => undefined,
    // Resolves the SAME gate `collect()` is waiting on — the engine's own
    // `result.status` becomes "cancelled" once its run loop actually
    // finishes (engine.ts:415), which is what lets `announceStretchEnd`
    // (and so `segment.completed`) fire at all; a `cancel()` that never
    // unblocks `collect()` would leave the whole `engine.run()` pending
    // forever, and no terminal producer ever runs.
    cancel: (): void => {
      open();
    },
    release: (): void => {
      open();
    },
  });
}

function spec(): Record<string, unknown> {
  return { meta: { name: "audit-segment" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

function checkpointSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-segment-resume" },
    nodes: [{ id: "gate", type: "checkpoint", prompt: "go?" }],
  };
}

function harness(options: { readonly runtime?: ChildRuntime } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-segment-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({
    runtime: options.runtime ?? completingRuntime(),
    auditTrail: trail,
    store,
  });
  return {
    service,
    repository,
    locks,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  const value = row.audit_segment_id;
  expect(typeof value).toBe("string");
  return value as string;
}

describe("workflow audit — segment/pause/process_crash producers (#368)", () => {
  it("segment.started is the FIRST event of a stretch, segment.completed the LAST before workflow.done, same segment_id", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events[0]?.event_type).toBe("segment.started");
      expect(page.events.at(-1)?.event_type).toBe("workflow.done");
      const segmentDoneIndex = page.events.findIndex(
        (event) => event.event_type === "segment.completed",
      );
      expect(segmentDoneIndex).toBe(page.events.length - 2); // right before workflow.done
      for (const event of [page.events[0], page.events[segmentDoneIndex]])
        expect(event?.identity.segment_id).toBe(segmentId);
      expect(page.events[0]?.data).toMatchObject({ attempt: 1, status: "running" });
      expect(page.events[segmentDoneIndex]?.data).toMatchObject({
        status: "complete",
        terminal: true,
      });
    } finally {
      close();
    }
  });

  it("a fresh (attempt 1) launch and a resume (attempt 2) both bracket their own stretch with segment.*", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(checkpointSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const firstSegment = segmentIdOf(repository, started.run_id);
      const firstPage = audit.query({ runId: started.run_id, segmentId: firstSegment, limit: 50 });
      const firstStart = firstPage.events.find((event) => event.event_type === "segment.started");
      expect(firstStart?.data).toMatchObject({ attempt: 1 });

      const resumed = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { gate: "yes" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const secondSegment = segmentIdOf(repository, started.run_id);
      const secondPage = audit.query({
        runId: started.run_id,
        segmentId: secondSegment,
        limit: 50,
      });
      const secondStart = secondPage.events.find((event) => event.event_type === "segment.started");
      expect(secondStart?.data).toMatchObject({ attempt: 2 });

      // A clean resume never records process_crash.
      const whole = audit.query({ runId: started.run_id, limit: 100 });
      expect(whole.events.some((event) => event.data.reason === "process_crash")).toBe(false);
    } finally {
      close();
    }
  });

  it("node.paused names the checkpoint's node_id when the run pauses at a checkpoint", async () => {
    const { service, audit, close } = harness();
    try {
      const started = service.start(checkpointSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const paused = page.events.find((event) => event.event_type === "node.paused");
      expect(paused?.data).toMatchObject({ reason: "checkpoint" });
      expect(paused?.identity.node_path).toEqual(["gate"]);
    } finally {
      close();
    }
  });

  it("node.paused falls back to the last RUNNING node for a quota pause (no checkpoint payload to name it)", async () => {
    const runtime: ChildRuntime = withMinimalLeafSandbox({
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({
        status: "failed",
        output: null,
        errorKind: "quota_exhausted",
        retryAfter: null,
      }),
      steer: () => undefined,
      cancel: () => undefined,
    });
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start({
        meta: { name: "audit-segment-quota" },
        nodes: [{ id: "a", type: "agent", prompt: "one" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const paused = page.events.find((event) => event.event_type === "node.paused");
      expect(paused?.data).toMatchObject({ reason: "quota_exhausted" });
      expect(paused?.identity.node_path).toEqual(["a"]);
    } finally {
      close();
    }
  });

  it("a dead-owner (orphaned) resume closes the PRIOR segment as interrupted/process_crash, then audit.gap{process_crash}, both under the NEW fence, before segment.started", async () => {
    const { service, repository, locks, audit, close } = harness();
    try {
      const priorFence = locks.acquireRunLease("orphan-seg", "dead-process", 1000, 900);
      if (priorFence === null) throw new Error("expected lease");
      const priorSegmentId = "the-segment-a-dead-process-owned";
      repository.putRunState("orphan-seg", {
        name: "audit-segment",
        owner: "dead-process",
        status: "running",
        pauseReason: null,
        pausePayloadJson: null,
        specJson: JSON.stringify(spec()),
        argsJson: "{}",
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: priorSegmentId,
        updatedAt: 1000,
        fence: priorFence,
        holder: "dead-process",
        now: 1000,
      });
      locks.releaseRunLease("orphan-seg", "dead-process");
      const resumed = service.start(null, {}, { resumeRunId: "orphan-seg" });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status("orphan-seg", true);
      const page = audit.query({ runId: "orphan-seg", limit: 50 });
      const types = page.events.map((event) => event.event_type);
      const crashIndex = types.indexOf("segment.completed");
      const gapIndex = types.indexOf("audit.gap");
      const startIndex = types.indexOf("segment.started");
      expect(crashIndex).toBeGreaterThanOrEqual(0);
      expect(gapIndex).toBeGreaterThan(crashIndex);
      expect(startIndex).toBeGreaterThan(gapIndex);
      expect(page.events[crashIndex]?.identity.segment_id).toBe(priorSegmentId);
      expect(page.events[crashIndex]?.data).toMatchObject({
        status: "interrupted",
        reason: "process_crash",
      });
      expect(page.events[gapIndex]?.data).toMatchObject({
        reason: "process_crash",
        count_state: "unavailable",
      });
      expect(page.integrity.refused_writes).toBe(0);
    } finally {
      close();
    }
  });

  it("shutdown() flushes: segment.completed{cancelled} of a run cancelled by service.shutdown() lands in the ledger once shutdown() resolves", async () => {
    const runtime = gatedRuntime();
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      await service.shutdown();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.data).toMatchObject({ status: "cancelled" });
    } finally {
      close();
    }
  });
});
