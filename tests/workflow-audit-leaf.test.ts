// Issue #366: `auditedChildRuntime` decorates `ChildRuntime` so every leaf a
// `WorkflowEngine` spawns produces `leaf.started`/`leaf.completed`/
// `leaf.failed` in the audit ledger, with the SAME causal identity the
// engine already builds per spawn (`CausalContext`). Built through
// `WorkflowService` (real sqlite-backed `AuditRepository`/`WorkflowRepository`/
// `AuditTrail`), not through `audit-runtime.ts` directly — that module is
// `service.ts`'s implementation detail; this file pins the OBSERVABLE
// contract the issue's Acceptance Criteria describe. RED on `main` 00392c17:
// zero `leaf.*` events ever reach the ledger (no producer wires
// `auditedChildRuntime` — the module does not exist).
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
import { auditedRuntimeFor } from "../src/workflow/audit-runtime.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  CausalContext,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import type { WorkflowLoader } from "../src/workflow/engine-contract.js";
import type { Timer } from "../src/workflow/durability.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** One `spawn()` gets one queue of scripted `collect()` results, consumed in
 * order — the exact shape needed to prove a schema retry's `steer()` +
 * SECOND `collect()` on the same id never produces a second terminal. */
function scriptedRuntime(scripts: readonly (readonly ChildResult[])[]): ChildRuntime & {
  readonly spawned: ChildSpawnRequest[];
  readonly steered: readonly Readonly<{ id: string; prompt: string }>[];
  readonly cancelled: string[];
} {
  const spawned: ChildSpawnRequest[] = [];
  const steered: Readonly<{ id: string; prompt: string }>[] = [];
  const cancelled: string[] = [];
  const byId = new Map<string, ChildResult[]>();
  return withMinimalLeafSandbox({
    spawned,
    steered,
    cancelled,
    spawn(request: ChildSpawnRequest): string {
      const id = `leaf-${String(spawned.length + 1)}`;
      byId.set(id, [...(scripts[spawned.length] ?? [])]);
      spawned.push(request);
      return id;
    },
    collect(id: string): ChildResult {
      const queue = byId.get(id) ?? [];
      return queue.shift() ?? { status: "failed", output: "script exhausted" };
    },
    // #444: the schema-retry `steer()` this scriptedRuntime exists for
    // always arrives AFTER the leaf's first `collect()` already returned
    // "complete" (engine.ts:274-296) — the entry is idle, not inFlight, so
    // the REAL `OrchestrationCore.steer` (core.ts:331-345) always takes the
    // idle/terminal "resurrect" branch and returns `{queued: false}` (no
    // `refused`), a genuine delivery. `auditedChildRuntime.steer`
    // (audit-runtime.ts) now needs that proof of delivery before it
    // records `leaf.steered` — a plain `void` return here would look
    // identical to a `ChildRuntime` that reports nothing at all.
    //
    // Issue #450: `steer` is real `void`, never called by the decorator
    // while `steerOutcome` (below) is present.
    steer(): void {
      throw new Error("scriptedRuntime.steer must not be called while steerOutcome is present");
    },
    steerOutcome(id: string, prompt: string) {
      steered.push({ id, prompt });
      return { queued: false };
    },
    cancel(id: string): void {
      cancelled.push(id);
    },
  });
}

/** Every leaf completes immediately with `USAGE`; every spawn request is
 * captured. */
function completingRuntime(): ChildRuntime & { readonly requests: ChildSpawnRequest[] } {
  const requests: ChildSpawnRequest[] = [];
  let seq = 0;
  return withMinimalLeafSandbox({
    requests,
    spawn(request: ChildSpawnRequest): string {
      requests.push(request);
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

/** A single leaf that stays in flight until `release()` — the window a live
 * run needs for `cancel()`/`shutdown()` to observe it as not-yet-settled;
 * its own `cancel()` is a no-op, so only the DECORATOR's bookkeeping closes
 * the leaf as cancelled. */
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
    cancel: () => undefined,
    release: (): void => {
      open();
    },
  });
}

function spec(): Record<string, unknown> {
  return { meta: { name: "audit-leaf" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

function schemaSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-leaf-schema" },
    nodes: [{ id: "a", type: "agent", prompt: "one", schema: SCHEMA }],
  };
}

function timeoutSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-leaf-timeout" },
    nodes: [{ id: "a", type: "agent", prompt: "one", timeout: 1 }],
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

function pipelineSpec(count: number): Record<string, unknown> {
  return {
    meta: { name: "audit-leaf-pipeline" },
    nodes: [
      {
        id: "p",
        type: "pipeline",
        items: Array.from({ length: count }, (_, index) => `item-${String(index)}`),
        stages: [{ prompt: "${item}" }],
      },
    ],
  };
}

/** Real sqlite-backed durable store: `WorkflowRepository` + `LockRepository`
 * + `AuditRepository`/`AuditTrail` over ONE connection — exactly the
 * composition `WorkflowService` sees in production. */
function harness(
  options: {
    readonly runtime?: ChildRuntime;
    readonly loader?: WorkflowLoader;
    readonly maxEventsPerRun?: number;
    readonly timerFactory?: (delay: number, fire: () => void) => Timer;
    readonly idSource?: () => string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-leaf-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(
    connection.database,
    options.maxEventsPerRun === undefined ? {} : { maxEventsPerRun: options.maxEventsPerRun },
  );
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
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    ...(options.timerFactory === undefined ? {} : { timerFactory: options.timerFactory }),
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

describe("workflow audit — leaf producers (#366)", () => {
  it("a leaf gets leaf.started then leaf.completed, exactly once each, with the spawn's identity", async () => {
    const runtime = scriptedRuntime([[{ status: "complete", output: { ok: true }, usage: USAGE }]]);
    const { service, repository, audit, close } = harness({ runtime });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.completed"]);
      for (const event of leaves) {
        expect(event.identity.segment_id).toBe(segmentId);
        expect(event.identity.sub_id).toBe("leaf-1"); // the id `spawn()` returned
        expect(event.identity.node_path).toEqual(["a"]);
        expect(event.identity.attempt).toBe(0);
      }
      expect(leaves[0]?.data.role).toBe("agent");
      expect(leaves[0]?.data.node_path).toEqual(["a"]);
      expect(leaves[1]?.data.status).toBe("complete");
      expect(leaves[1]?.data.usage).toEqual({ tokens_in: 3, tokens_out: 5 });
      expect(leaves[1]?.data.usage_uncertain).toBe(false);
      expect(runtime.spawned).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("a leaf that fails carries status:failed and usage_uncertain:true when the ChildResult marks it", async () => {
    const runtime = scriptedRuntime([
      [{ status: "failed", output: "dead", usage: USAGE, usageUncertain: true }],
    ]);
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.failed"]);
      expect(leaves[1]?.data).toMatchObject({ status: "failed", usage_uncertain: true });
    } finally {
      close();
    }
  });

  it("schema retry (steer + second collect on the SAME id) produces only ONE started and ONE terminal", async () => {
    const runtime = scriptedRuntime([
      [
        { status: "complete", output: {}, usage: USAGE }, // fails the schema
        { status: "complete", output: { ok: true }, usage: USAGE }, // steer() fixed it
      ],
    ]);
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start(schemaSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      expect(runtime.steered.map((call) => call.id)).toEqual(["leaf-1"]);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      // #423: leaf.steered (post-terminal — see audit-runtime.ts) joins the
      // list; still only ONE leaf.completed, the invariant this title names.
      expect(leaves.map((event) => event.event_type)).toEqual([
        "leaf.started",
        "leaf.completed",
        "leaf.steered",
      ]);
      expect(runtime.spawned).toHaveLength(1); // steer() reuses the SAME leaf, no respawn
    } finally {
      close();
    }
  });

  it("a leaf timeout (wait:true collect returning running) closes ONCE as interrupted/timeout — the engine's follow-up cancel() adds nothing", async () => {
    const runtime = scriptedRuntime([[{ status: "running", output: null }]]);
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start(timeoutSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      expect(runtime.cancelled).toEqual(["leaf-1"]); // the engine's own timeout cancel
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.failed"]);
      expect(leaves[1]?.data).toMatchObject({ status: "interrupted", reason: "timeout" });
    } finally {
      close();
    }
  });

  // Issue #383, item 2 (veredito da PR #382): `audit-runtime.ts`'s collect()
  // decorator has TWO branches for a non-terminal ChildResult — `wait:true`
  // returning "running" closes the leaf as an interrupted/timeout (tested
  // just above); `wait:false` returning "running" must NOT close anything,
  // since nothing terminal happened yet (a caller that polls without
  // waiting expects to poll again later). No production caller sets
  // `wait:false` today — `engine.ts`'s two `collect()` call sites both
  // hardcode `wait:true` — so this branch is only reachable by driving the
  // decorator directly, the same "one exception to never audit-runtime.ts's
  // internals" `tests/workflow-audit-tool.test.ts` already takes for its
  // (c) scenario (issue #378) when a WorkflowService turn cannot reach the
  // seam under test.
  it("collect wait:false returning running emits no terminal — only a later done/cancel closes the leaf", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-leaf-waitfalse-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      let scripted: ChildResult = { status: "running", output: null };
      const causalContext: CausalContext = {
        runId: "run-waitfalse",
        segmentId: "seg-waitfalse",
        nodePath: ["a"],
        cellId: "a",
        role: "agent",
        attempt: 0,
        turn: 0,
      };
      const runtime = auditedRuntimeFor(
        withMinimalLeafSandbox({
          spawn: (): string => "leaf-1",
          collect: (): ChildResult => scripted,
          steer: () => undefined,
          cancel: (): void => undefined,
        }),
        trail,
        () => null,
        false,
        () => undefined,
      );
      const id = await runtime.spawn({ prompt: "one", causalContext });
      const collected = await runtime.collect(id, { wait: false, timeoutSeconds: 1 });
      expect(collected.status).toBe("running");
      await trail.flush();
      const midway = audit.query({ runId: "run-waitfalse", limit: 50 });
      const leavesMidway = midway.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leavesMidway.map((event) => event.event_type)).toEqual(["leaf.started"]);

      scripted = { status: "complete", output: { ok: true }, usage: USAGE };
      await runtime.collect(id, { wait: true, timeoutSeconds: 1 });
      await trail.flush();
      const after = audit.query({ runId: "run-waitfalse", limit: 50 });
      const leavesAfter = after.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leavesAfter.map((event) => event.event_type)).toEqual([
        "leaf.started",
        "leaf.completed",
      ]);
    } finally {
      connection.close();
    }
  });

  it("cancel(): a leaf still open when the run is cancelled is recorded once as leaf.failed cancelled", async () => {
    const timers: { fire(): void }[] = [];
    const timerFactory = (_delay: number, fire: () => void): Timer => {
      timers.push({ fire });
      return { cancel: (): void => undefined };
    };
    const runtime = gatedRuntime();
    const { service, audit, trail, close } = harness({ runtime, timerFactory });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const armedBefore = timers.length; // the lease heartbeat, armed on acquisition
      const done = Promise.resolve(service.cancel(started.run_id));
      expect(timers.length).toBe(armedBefore + 1); // the settle ceiling, armed synchronously
      timers[timers.length - 1]?.fire(); // the leaf is still gated — the ceiling elapses
      await done;
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({ status: "cancelled", reason: "cancelled" });
      runtime.release();
    } finally {
      close();
    }
  });

  it("shutdown() flushes: a leaf cancelled by service.shutdown() lands in the ledger once shutdown() resolves", async () => {
    const timers: { fire(): void }[] = [];
    const timerFactory = (_delay: number, fire: () => void): Timer => {
      timers.push({ fire });
      return { cancel: (): void => undefined };
    };
    const runtime = gatedRuntime();
    const { service, audit, close } = harness({ runtime, timerFactory });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const done = service.shutdown();
      timers[timers.length - 1]?.fire(); // the settle ceiling, armed synchronously
      await done;
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({ status: "cancelled", reason: "cancelled" });
    } finally {
      close();
    }
  });

  it("a nested workflow's leaf shares the parent's segment_id and comes out with a scoped node_path", async () => {
    const runtime = completingRuntime();
    const { service, repository, audit, close } = harness({
      runtime,
      loader: () => innerSpec,
    });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const started_ = page.events.filter((event) => event.event_type === "leaf.started");
      expect(started_).toHaveLength(2); // "top" and the nested "leaf"
      for (const event of started_) expect(event.identity.segment_id).toBe(segmentId);
      const nodePaths = started_.map((event) => event.data.node_path);
      expect(nodePaths).toEqual(expect.arrayContaining([["top"], ["sub", "leaf"]]));
    } finally {
      close();
    }
  });

  it("a pipeline leaf's role is pipeline.stage and carries item_index/stage_index", async () => {
    const runtime = completingRuntime();
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start(pipelineSpec(3));
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const started_ = page.events.filter((event) => event.event_type === "leaf.started");
      expect(started_).toHaveLength(3);
      for (const event of started_) {
        expect(event.data.role).toBe("pipeline.stage");
        expect(typeof event.data.item_index).toBe("number");
        expect(event.data.stage_index).toBe(0);
      }
    } finally {
      close();
    }
  });

  it("sanitization: a unicode canary in the prompt and in the output never reaches a leaf.* payload", async () => {
    const promptCanary = "UNICODE-CANARY-\u{1F512}-PROMPT";
    const outputCanary = "UNICODE-CANARY-\u{1F513}-OUTPUT";
    const runtime = withMinimalLeafSandbox<ChildRuntime>({
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({ status: "complete", output: outputCanary, usage: USAGE }),
      steer: () => undefined,
      cancel: () => undefined,
    });
    const { service, audit, close } = harness({ runtime });
    try {
      const started = service.start({
        meta: { name: "audit-leaf-canary" },
        nodes: [{ id: "a", type: "agent", prompt: promptCanary }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.length).toBeGreaterThan(0);
      const rendered = JSON.stringify(leaves);
      expect(rendered).not.toContain(promptCanary);
      expect(rendered).not.toContain(outputCanary);
    } finally {
      close();
    }
  });

  it("the non-durable path (no store) also produces leaf.started/leaf.completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-leaf-ephemeral-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const runtime = scriptedRuntime([
        [{ status: "complete", output: { ok: true }, usage: USAGE }],
      ]);
      const service = new WorkflowService({
        runtime,
        auditTrail: trail,
        environment: { VITEST: "true" },
        idSource: () => "ephemeral-audit-leaf",
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.completed"]);
    } finally {
      connection.close();
    }
  });

  it("volume: leaves beyond a small retention cap prune without crashing or reordering", async () => {
    const runtime = completingRuntime();
    const { service, audit, trail, close } = harness({ runtime, maxEventsPerRun: 20 });
    try {
      const started = service.start(pipelineSpec(40));
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 200 });
      expect(page.events.length).toBeLessThanOrEqual(20);
      const seqs = page.events.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right)); // never out of order
      const notices = page.integrity.notices as readonly Readonly<Record<string, unknown>>[];
      const retentionGap = notices.find(
        (notice) =>
          notice.event_type === "audit.gap" &&
          (notice.data as Readonly<Record<string, unknown>> | undefined)?.reason ===
            "retention_limit",
      );
      expect(retentionGap).toBeDefined();
      const droppedCount = (retentionGap?.data as Readonly<Record<string, unknown>> | undefined)
        ?.dropped_count;
      expect(typeof droppedCount).toBe("number");
      // Discriminates against a run with NO leaf.* events at all: without
      // them, nothing retained after pruning could start with "leaf.".
      expect(page.events.some((event) => event.event_type.startsWith("leaf."))).toBe(true);
    } finally {
      close();
    }
  });

  it("fail-closed: a leaf.completed produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger — leaf.started (recorded before the eviction) does, and a warn names the drop", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-leaf-eviction-"));
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
      const runtime: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        // Eviction fires INSIDE collect() — after spawn() already recorded
        // leaf.started under this stretch's still-valid fence, and before
        // collect()'s own leaf.completed gets a chance to record under it.
        collect: (): ChildResult => {
          const owner = running.service;
          if (!evicted && owner !== null) {
            evicted = true;
            const second = owner.start(spec());
            if ("error" in second) throw new Error(second.error);
          }
          return { status: "complete", output: { ok: true }, usage: USAGE };
        },
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
      await service.status(first.run_id, true);
      expect(evicted).toBe(true);
      await trail.flush();
      const page = audit.query({ runId: first.run_id, limit: 50 });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started"]);
      expect(
        warnings.some(
          (message) => message.includes("ownership lost") && message.includes("leaf.completed"),
        ),
      ).toBe(true);
    } finally {
      connection.close();
    }
  });
});
