// Issue #365: `segment_id` — the identity of ONE acquisition — now reaches
// the audit ledger and `workflow_run_state.audit_segment_id`, and the
// `causalContext` a leaf's spawn request carries is the SAME value. Before
// this issue, `audit_segment_id` was always `null` (`service.ts:924` on main
// 7fd10ea2) and no audit event ever carried `identity.segment_id`.
//
// Deliberately built through `WorkflowService` + a real sqlite-backed
// `AuditRepository`/`WorkflowRepository`/`AuditTrail`, not through the new
// `audit-producers.ts` module directly — the module is an implementation
// detail of the service, and these tests pin the OBSERVABLE contract the
// issue's Acceptance Criteria describe.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { createSessionToolBase } from "../src/commands/session-tools.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import type { WorkflowLoader } from "../src/workflow/engine-contract.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** A leaf sandbox installation minimal enough that no test here exercises
 * tool dispatch — `WorkflowService` refuses a durable launch without one. */
function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** Every leaf completes immediately; every spawn request is captured, so a
 * test can inspect `causalContext.segmentId` after the run settles. */
function capturingRuntime(): ChildRuntime & { readonly requests: ChildSpawnRequest[] } {
  const requests: ChildSpawnRequest[] = [];
  let seq = 0;
  return withMinimalLeafSandbox({
    requests,
    spawn(request: ChildSpawnRequest): string {
      requests.push(request);
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" }, usage: USAGE }),
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
      return { status: "complete", output: { answer: "ok" }, usage: USAGE };
    },
    steer: () => undefined,
    cancel: () => undefined,
    release: (): void => {
      open();
    },
  });
}

function spec(): Record<string, unknown> {
  return { meta: { name: "audit-identity" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

function checkpointSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-identity-resume" },
    nodes: [{ id: "gate", type: "checkpoint", prompt: "go?" }],
  };
}

const innerSpec = {
  meta: { name: "inner" },
  nodes: [{ id: "leaf", type: "agent", prompt: "inner work" }],
};

function nestedSpec(): Record<string, unknown> {
  return {
    meta: { name: "outer" },
    nodes: [
      { id: "top", type: "agent", prompt: "outer work" },
      { id: "sub", type: "workflow", ref: "inner" },
    ],
  };
}

/** Real sqlite-backed durable store: `WorkflowRepository` + `LockRepository`
 * + `AuditRepository`/`AuditTrail` over ONE connection, exactly the
 * composition `WorkflowService` sees in production. */
function harness(
  options: {
    readonly runtime?: ChildRuntime;
    readonly loader?: WorkflowLoader;
    readonly onWarning?: (message: string) => void;
    readonly idSource?: () => string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-identity-"));
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
    runtime: options.runtime ?? capturingRuntime(),
    auditTrail: trail,
    store,
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    ...(options.idSource === undefined ? {} : { idSource: options.idSource }),
  });
  return {
    service,
    repository,
    locks,
    audit,
    trail,
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

describe("workflow audit — causal identity (#365)", () => {
  it("every event of a durable run carries the SAME segment_id the durable line publishes", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      expect(segmentId.length).toBeGreaterThan(0);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events.length).toBeGreaterThan(0);
      for (const event of page.events) expect(event.identity.segment_id).toBe(segmentId);
    } finally {
      close();
    }
  });

  it("a resume mints a NEW segment_id — AuditRepository.query({segmentId}) separates the two stretches without sobra nor falta", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(checkpointSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true); // settles paused at "gate"
      const firstSegment = segmentIdOf(repository, started.run_id);
      const resumed = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          checkpointAnswers: { gate: "yes" },
        },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const secondSegment = segmentIdOf(repository, started.run_id);
      expect(secondSegment).not.toBe(firstSegment);
      const firstPage = audit.query({ runId: started.run_id, segmentId: firstSegment, limit: 50 });
      const secondPage = audit.query({
        runId: started.run_id,
        segmentId: secondSegment,
        limit: 50,
      });
      expect(firstPage.events.length).toBeGreaterThan(0);
      expect(secondPage.events.length).toBeGreaterThan(0);
      const wholePage = audit.query({ runId: started.run_id, limit: 100 });
      // no sobra: every event belongs to exactly one of the two segments;
      // no falta: the two segments' events add up to the whole ledger.
      expect(firstPage.events.length + secondPage.events.length).toBe(wholePage.events.length);
    } finally {
      close();
    }
  });

  // Issue #368 (emenda 2026-09-11): pre-existing bug found while implementing
  // #368, NOT a regression of it — confirmed on unmodified main: a durable
  // run's terminal producer call (`announceDone` on main; `announceStretchEnd`
  // here) queues its event and returns; `finishStretch()` (the very next
  // statement) deletes `workflow_run_locks` SYNCHRONOUSLY, before the
  // `AuditTrail` queue's own microtask ever gets to drain it — so
  // `AuditRepository.append`'s fence JOIN finds nothing and refuses the write,
  // silently (no gap, no warning, pre-fix). `workflow.done` NEVER reached the
  // ledger for ANY durable run. Fixed by draining the trail UNDER the live
  // fence, inside `finishStretch`, before it releases the lease
  // (`producers.flushBeforeRelease()`, audit-producers.ts).
  it("a durable run's terminal write (workflow.done, segment.completed) actually reaches the ledger", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const types = page.events.map((event) => event.event_type);
      expect(types).toContain("workflow.done");
      expect(types).toContain("segment.completed");
      const done = page.events.find((event) => event.event_type === "workflow.done");
      expect(done?.identity.segment_id).toBe(segmentId);
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.identity.segment_id).toBe(segmentId);
      expect(page.integrity.refused_writes).toBe(0);
    } finally {
      close();
    }
  });

  it("a dead-owner resume closes the PRIOR segment as interrupted/process_crash and records an audit.gap, under the NEW fence — a paused (checkpoint) resume records neither", async () => {
    const { service, repository, locks, audit, close } = harness();
    try {
      const priorFence = locks.acquireRunLease("orphan-run", "dead-process", 1000, 900);
      if (priorFence === null) throw new Error("expected lease");
      const priorSegmentId = "prior-segment-from-a-dead-process";
      repository.putRunState("orphan-run", {
        name: "audit-identity",
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
      locks.releaseRunLease("orphan-run", "dead-process"); // simulates a lease that expired
      const resumed = service.start(null, {}, { resumeRunId: "orphan-run" });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status("orphan-run", true);
      const newSegmentId = segmentIdOf(repository, "orphan-run");
      expect(newSegmentId).not.toBe(priorSegmentId);
      const page = audit.query({ runId: "orphan-run", limit: 50 });
      const crashClose = page.events.find(
        (event) =>
          event.event_type === "segment.completed" && event.identity.segment_id === priorSegmentId,
      );
      expect(crashClose).toBeDefined();
      expect(crashClose?.data).toMatchObject({ status: "interrupted", reason: "process_crash" });
      const gap = page.events.find(
        (event) => event.event_type === "audit.gap" && event.data.reason === "process_crash",
      );
      expect(gap).toBeDefined();
      expect(gap?.data).toMatchObject({ reason: "process_crash", count_state: "unavailable" });
      // both land BEFORE the new segment's own segment.started.
      const newStart = page.events.find(
        (event) =>
          event.event_type === "segment.started" && event.identity.segment_id === newSegmentId,
      );
      expect(newStart).toBeDefined();
      expect((crashClose?.seq as number) < (newStart?.seq as number)).toBe(true);
      expect((gap?.seq as number) < (newStart?.seq as number)).toBe(true);

      // A clean (paused-at-checkpoint) resume is NOT a dead-owner resume —
      // never records process_crash.
      const paused = service.start(checkpointSpec());
      if ("error" in paused) throw new Error(paused.error);
      await service.status(paused.run_id, true);
      const cleanResume = service.start(
        null,
        {},
        { resumeRunId: paused.run_id, checkpointAnswers: { gate: "yes" } },
      );
      if ("error" in cleanResume) throw new Error(cleanResume.error);
      await service.status(paused.run_id, true);
      const cleanPage = audit.query({ runId: paused.run_id, limit: 50 });
      expect(cleanPage.events.some((event) => event.data.reason === "process_crash")).toBe(false);
    } finally {
      close();
    }
  });

  it("the non-durable path (no store) also publishes segment_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-identity-ephemeral-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const service = new WorkflowService({
        runtime: capturingRuntime(),
        auditTrail: trail,
        environment: { VITEST: "true" },
        idSource: () => "ephemeral-audit-identity",
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events.length).toBeGreaterThan(0);
      for (const event of page.events) {
        expect(typeof event.identity.segment_id).toBe("string");
        expect((event.identity.segment_id as string).length).toBeGreaterThan(0);
      }
    } finally {
      connection.close();
    }
  });

  it("causalContext.segmentId at every spawn — top-level AND inside a nested workflow leaf — matches the published identity", async () => {
    const runtime = capturingRuntime();
    const { service, repository, audit, close } = harness({
      runtime,
      loader: () => innerSpec,
    });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      expect(runtime.requests.length).toBe(2); // "top" and the nested "leaf"
      for (const request of runtime.requests) {
        expect(request.causalContext.segmentId).toBe(segmentId);
      }
      const page = audit.query({ runId: started.run_id, limit: 50 });
      for (const event of page.events) expect(event.identity.segment_id).toBe(segmentId);
    } finally {
      close();
    }
  });

  it("fail-closed: an event produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger, fenced or not — a warn names the drop", async () => {
    // FENCE_MEMORY shrunk to 1 (mirrors the existing eviction test in
    // workflow-service-durability.test.ts): run-1's own leaf launches
    // run-2 mid-spawn, forgetting run-1's token BEFORE its node events fire.
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-identity-eviction-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const warnings: string[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let evicted = false;
      let leafSeq = 0;
      const runtime: ChildRuntime = withMinimalLeafSandbox({
        spawn(): string {
          const owner = running.service;
          if (!evicted && owner !== null) {
            evicted = true;
            const second = owner.start(spec());
            if ("error" in second) throw new Error(second.error);
          }
          leafSeq += 1;
          return `leaf-${String(leafSeq)}`;
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: USAGE,
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      let n = 0;
      const service = new WorkflowService({
        runtime,
        auditTrail: trail,
        idSource: () => {
          n += 1;
          return `run-${String(n)}`;
        },
        fenceMemory: 1,
        onWarning: (message) => warnings.push(message),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      running.service = service;
      const first = service.start(spec());
      if ("error" in first) throw new Error(first.error);
      const result = (await service.status(first.run_id, true)) as Record<string, unknown>;
      expect(evicted).toBe(true);
      expect(result.error).toBe("workflow ownership lost");
      // The node's "running" event fires BEFORE spawn() (still fenced,
      // legitimately recorded); its "complete" event fires AFTER spawn()
      // evicted this stretch — that one must never land, fenced or not.
      const page = audit.query({ runId: first.run_id, eventType: "workflow.node", limit: 50 });
      expect(page.events.map((event) => event.data.state)).toEqual(["running"]);
      expect(warnings.some((message) => message.includes("ownership lost"))).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("shutdown() flushes: an event queued right before it lands in the ledger, with segment_id, once it resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-identity-shutdown-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const runtime = gatedRuntime();
      const service = new WorkflowService({
        runtime,
        auditTrail: trail,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const done = service.shutdown();
      runtime.release();
      await done;
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events.length).toBeGreaterThan(0);
      for (const event of page.events) expect(event.identity.segment_id).toBe(segmentId);
    } finally {
      connection.close();
    }
  });
});

// Issue #380: the audit trail's own warning sink used to reach only the
// default `() => undefined` in every production composition root —
// `chat.ts`/`dashboard.ts` built `AuditRepository`/`AuditTrail` with no
// `warning` option at all, so a fence refusal (already NAMED since #368)
// never left the process. These tests exercise `createSessionToolBase`
// (`session-tools.ts`) exactly as `chat.ts`/`dashboard.ts` call it — the
// shared factory both composition roots build their `SessionToolBase` from.
describe("audit warning sink (#380)", () => {
  function openDb(): {
    database: ReturnType<typeof openStateDatabase>["database"];
    close: () => void;
  } {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-warning-sink-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    return {
      database: connection.database,
      close: () => {
        connection.close();
      },
    };
  }

  // No fence/lock row exists for this run id at all, so
  // `AuditRepository.append`'s ownership JOIN finds nothing and refuses —
  // exactly the "concurrent resume, late heartbeat" case #368 named.
  const staleOwnership = Object.freeze({ fence: 1, holder: "nobody", now: 1_000 });

  it("createSessionToolBase no longer defaults the audit warning sink to silence", () => {
    const { database, close } = openDb();
    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        // Exactly the 2-arg call `session-tools.test.ts` already makes —
        // no explicit `warning` passed, so this exercises the DEFAULT.
        const base = createSessionToolBase(database, {});
        const refused = base.auditRepository.append(
          "orphan-run",
          { event_type: "node.started" },
          staleOwnership,
        );
        expect(refused).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain("fence lost");
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      close();
    }
  });

  it("a fence refusal reaches an injected sink through AuditRepository AND AuditTrail together — exactly once, not two or three times", async () => {
    const { database, close } = openDb();
    try {
      const warnings: string[] = [];
      const auditWarning = (message: string): void => {
        warnings.push(message);
      };
      // Not via the factory: constructs `AuditRepository`/`AuditTrail`
      // directly, the same SAME sink passed to BOTH — exactly the shape
      // `chat.ts`/`dashboard.ts` wire (`createSessionToolBase`'s
      // `auditRepository` and the `AuditTrail` wrapping it), isolated from
      // that factory so this test pins the dedup itself, not the plumbing
      // (covered separately above).
      const repository = new AuditRepository(database, { warning: auditWarning });
      const trail = new AuditTrail(repository, { warning: auditWarning });
      expect(trail.record("orphan-run", { event_type: "node.started" }, staleOwnership)).toBe(true); // accepted onto the queue; the refusal happens on drain.
      expect(await trail.flush()).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("fence lost");
      expect(warnings[0]).toContain("orphan-run");
    } finally {
      close();
    }
  });

  it("AuditRepository.refusals is bounded — the oldest run's count is evicted, not kept forever", () => {
    const { database, close } = openDb();
    try {
      const repo = new AuditRepository(database, { maxRuns: 2 });
      const refuse = (runId: string): void => {
        expect(repo.append(runId, { event_type: "node.started" }, staleOwnership)).toBeNull();
      };
      refuse("run-a");
      refuse("run-b");
      refuse("run-c"); // pushes the map past maxRuns=2 — "run-a" is the oldest.
      expect(repo.query({ runId: "run-a" }).integrity.refused_writes).toBe(0);
      expect(repo.query({ runId: "run-b" }).integrity.refused_writes).toBe(1);
      expect(repo.query({ runId: "run-c" }).integrity.refused_writes).toBe(1);
    } finally {
      close();
    }
  });
});
