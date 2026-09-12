// Issue #424 (M10-S3, épico #421): `workflow_steer {run_id, node_id? | sub_id?,
// message}` — an operator-origin steer at a NAMED node/leaf of a live
// workflow run, resolved through the run's audit ledger (`leaf.started`
// minus any terminal `leaf.completed`/`leaf.failed`, same fail-closed
// membership check `leaf-read-tool.ts:13-40` documents), delivered through
// `AuditedChildRuntime.steer(subId, message, causal, "operator")` (S2,
// #423) so the SAME per-stretch decorator records `leaf.steered
// {source: "operator"}`.
//
// Two groups here, split by what each needs from the base commit:
//
// 1. "registry wiring" reads ONLY code that already exists on the base
//    (`createBuiltinRegistry`, `CHILD_EXCLUDED_TOOLS`) — a real ASSERTION
//    failure on the base (`workflow_steer` genuinely absent from both),
//    never an import/collection error (`controle-negativo`'s
//    `assertion-red`, not `structural-red`).
// 2. "workflow_steer tool" needs the new module itself
//    (`src/workflow/steer-tool.ts`, not on the base) — imported
//    DYNAMICALLY inside each `it` (never a static top-level import of a
//    symbol the base doesn't have) so a module-not-found rejection fails
//    only THAT test, not the whole file's collection.
//
// The happy-path test drives a REAL `WorkflowService` (real sqlite
// `AuditRepository`/`AuditTrail`/`WorkflowRepository`/`LockRepository`,
// same composition `tests/workflow-audit-steered.test.ts` uses) with a
// scripted `ChildRuntime` whose `collect()` blocks on a deferred promise —
// the SAME "blocked leaf" shape `workflow-audit-steered.test.ts` uses for
// its schema-retry scenario, adapted so the block lasts until THIS test
// calls `workflow_steer` and inspects the result. This is a scripted
// `ChildRuntime`, not a real `OrchestrationCore` — `drainMessages()` (the
// core's own inbox drain) is therefore not directly assertable here; the
// scripted runtime's own `steered` array (what actually reached the
// `ChildRuntime` port) plus the REAL `leaf.steered{source:"operator"}`
// ledger event (which only the real per-stretch `AuditedChildRuntime`
// decorator, not a mock, can produce) are the two things this test proves
// instead — see the PR body for why.
//
// The negative-path/resolution tests (ambiguous node, unknown sub_id, zero
// live leaves, argument validation) never need an engine at all: they
// plant `leaf.started`/`leaf.completed` rows directly with
// `AuditRepository.append` (same fixture technique
// `tests/workflow-leaf-read-tool.test.ts`'s `plantLeaf` uses) and pass a
// fake `service` whose `liveRuntimeOf` throws if ever reached — proving
// resolution failures never touch the runtime at all.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuiltinRegistry } from "../src/tools/index.js";
import { CHILD_EXCLUDED_TOOLS } from "../src/tools/child.js";
import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
  SteerOutcome,
} from "../src/workflow/runtime.js";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** One spawn, one blocked `collect()` — released by the test AFTER it has
 * called `workflow_steer` on the still-running leaf. */
function blockedLeafRuntime(): ChildRuntime & {
  readonly steered: readonly Readonly<{ id: string; prompt: string }>[];
  release(result: ChildResult): void;
} {
  const steered: Readonly<{ id: string; prompt: string }>[] = [];
  const barrier = deferred<ChildResult>();
  return withMinimalLeafSandbox({
    steered,
    release: (result: ChildResult): void => {
      barrier.resolve(result);
    },
    spawn: (_request: ChildSpawnRequest): string => "leaf-1",
    collect: (): Promise<ChildResult> => barrier.promise,
    // Issue #450: `steer` itself is real `void` now (the port's own
    // declared type) — the outcome `workflow_steer` (steer-tool.ts) reads
    // comes from the NEW, separate `steerOutcome` member below, never from
    // `steer`'s return value.
    steer: (): void => undefined,
    steerOutcome: (id: string, prompt: string) => {
      steered.push({ id, prompt });
      return { queued: true };
    },
    cancel: (): void => undefined,
  });
}

/** One spawn, one blocked `collect()` — `steer` delegates but the runtime
 * reports NO outcome at all (no `steerOutcome` member), the shape every
 * `ChildRuntime` besides `OrchestrationChildRuntime` has today. */
function noOutcomeRuntime(): ChildRuntime & {
  readonly steered: readonly Readonly<{ id: string; prompt: string }>[];
  release(result: ChildResult): void;
} {
  const steered: Readonly<{ id: string; prompt: string }>[] = [];
  const barrier = deferred<ChildResult>();
  return withMinimalLeafSandbox({
    steered,
    release: (result: ChildResult): void => {
      barrier.resolve(result);
    },
    spawn: (_request: ChildSpawnRequest): string => "leaf-1",
    collect: (): Promise<ChildResult> => barrier.promise,
    steer: (id: string, prompt: string): void => {
      steered.push({ id, prompt });
    },
    cancel: (): void => undefined,
  });
}

/** A REAL `OrchestrationCore`/`OrchestrationChildRuntime` (issue #424, 2ª
 * emenda) — the ONLY thing that actually enforces `MAX_PENDING_STEERS_PER_
 * LEAF` (core.ts) or reports `null` for an id it never spawned. The
 * scripted `blockedLeafRuntime` above always answers `{queued: true}`,
 * same as `tests/workflow-audit-steered.test.ts`'s own posture — it exists
 * for the resolution/audit-event tests, not the cap. */
function realCoreRuntime(): {
  readonly runtime: ChildRuntime;
  readonly release: (result: CollectResult) => void;
} {
  const barrier = deferred<CollectResult>();
  const core = new OrchestrationCore({
    runChild: () => barrier.promise,
    idSource: () => "leaf-1",
    maxSubsessions: 200,
    maxParallel: 200,
    buildSubagentPrompt: (): string => "SUBAGENT_SYSTEM_STUB",
  });
  return {
    runtime: new OrchestrationChildRuntime(core),
    release: (result: CollectResult): void => {
      barrier.resolve(result);
    },
  };
}

const REAL_COLLECT_RESULT: CollectResult = {
  status: "complete",
  output: "done",
  tokensIn: 1,
  tokensOut: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "test",
  model: "test-model",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
};

function serviceHarness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-steer-tool-svc-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0, holder: "test", now: 1000 };
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({ runtime, auditTrail: trail, store });
  return {
    service,
    audit,
    trail,
    close: (): void => {
      connection.close();
    },
  };
}

function auditOnlyHarness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-steer-tool-audit-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const audit = new AuditRepository(connection.database);
  return {
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

/** Never reached by a resolution failure — proves argument/ambiguity/
 * membership errors short-circuit before touching the runtime. */
const unreachableService = {
  liveRuntimeOf(): never {
    throw new Error("liveRuntimeOf must not be reached");
  },
};

function spec(): Record<string, unknown> {
  return { meta: { name: "steer-tool" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function loadHandler() {
  const mod = await import("../src/workflow/steer-tool.js");
  return mod.workflowSteerHandler;
}

interface Envelope {
  readonly ok?: boolean;
  readonly error?: string;
  readonly sub_id?: string;
  readonly node_id?: string | null;
  readonly queued?: boolean;
}

describe("workflow_steer registry wiring (#424)", () => {
  it("is a real tool definition, excluded from subagents", () => {
    const registry = createBuiltinRegistry();
    const names = registry.getDefinitions().map((definition) => definition.function.name);
    expect(names).toContain("workflow_steer");
    expect(CHILD_EXCLUDED_TOOLS).toContain("workflow_steer");
  });

  // Issue #450 (PR #443 veredito, non_blocking a-1/a-2): type oracle, not an
  // assertion — the point is that this file COMPILES. `steerOutcome` is a
  // NEW, OPTIONAL member (`runtime.ts`), never a wider `steer`: the literal
  // below satisfies `ChildRuntime` with `steer` still real `void` AND a
  // `steerOutcome` that reports a real `SteerOutcome | null`, proving the
  // two never had to merge into one wider return.
  it("a ChildRuntime literal with steerOutcome satisfies the port without widening steer's void return", () => {
    const sample = {
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({ status: "complete", output: null }),
      steer: (): void => undefined,
      cancel: (): void => undefined,
      steerOutcome: (): SteerOutcome | null => ({ queued: true }),
    } satisfies ChildRuntime;
    expect(typeof sample.steerOutcome).toBe("function");
  });
});

describe("workflow_steer tool (#424)", () => {
  it("resolves by node_id, delivers the operator message to the live leaf, and records leaf.steered{source:operator}", async () => {
    const runtime = blockedLeafRuntime();
    const { service, audit, trail, close } = serviceHarness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await flushMicrotasks();
      await trail.flush();

      const workflowSteerHandler = await loadHandler();
      const handler = workflowSteerHandler(service, audit);
      const raw = await handler({
        run_id: started.run_id,
        node_id: "a",
        message: "please pause and hand back",
      });
      const result = JSON.parse(raw) as Envelope;
      expect(result.ok).toBe(true);
      expect(result.sub_id).toBe("leaf-1");
      expect(result.node_id).toBe("a");
      expect(result.queued).toBe(true);
      expect(runtime.steered).toEqual([{ id: "leaf-1", prompt: "please pause and hand back" }]);

      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const steeredEvents = page.events.filter((event) => event.event_type === "leaf.steered");
      expect(steeredEvents).toHaveLength(1);
      expect(steeredEvents[0]?.data.source).toBe("operator");

      runtime.release({ status: "complete", output: {}, usage: USAGE });
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });

  it("a runtime that reports no steerOutcome at all is a named fail-closed error, never queued:true (#450)", async () => {
    const runtime = noOutcomeRuntime();
    const { service, audit, trail, close } = serviceHarness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await flushMicrotasks();
      await trail.flush();

      const workflowSteerHandler = await loadHandler();
      const handler = workflowSteerHandler(service, audit);
      const raw = await handler({
        run_id: started.run_id,
        node_id: "a",
        message: "please pause and hand back",
      });
      const result = JSON.parse(raw) as Envelope;
      expect(result.ok).toBeUndefined();
      expect(result.error).toMatch(/steerOutcome/);
      // Fail-closed: never falls back to the plain `steer` and invents a
      // `queued: true` this tool has no proof of.
      expect(runtime.steered).toHaveLength(0);

      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);

      runtime.release({ status: "complete", output: {}, usage: USAGE });
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });

  it("resolves by sub_id directly, without node_id", async () => {
    const runtime = blockedLeafRuntime();
    const { service, audit, trail, close } = serviceHarness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await flushMicrotasks();
      await trail.flush();

      const workflowSteerHandler = await loadHandler();
      const handler = workflowSteerHandler(service, audit);
      const result = JSON.parse(
        await handler({ run_id: started.run_id, sub_id: "leaf-1", message: "keep going" }),
      ) as Envelope;
      expect(result.ok).toBe(true);
      expect(result.sub_id).toBe("leaf-1");
      expect(result.node_id).toBe("a");

      runtime.release({ status: "complete", output: {}, usage: USAGE });
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });

  it("requires exactly one of node_id/sub_id — both or neither is a named error, runtime never touched", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      const handler = workflowSteerHandler(unreachableService, audit);
      const both = JSON.parse(
        await handler({ run_id: "r1", node_id: "a", sub_id: "s1", message: "hi" }),
      ) as Envelope;
      expect(both.error).toMatch(/exactly one/);
      const neither = JSON.parse(await handler({ run_id: "r1", message: "hi" })) as Envelope;
      expect(neither.error).toMatch(/exactly one/);
    } finally {
      close();
    }
  });

  it("node_id with zero live leaves is a named error, runtime never touched", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      audit.append("run-x", { event_type: "leaf.started", sub_id: "leaf-1", node_id: "other" });
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-x", node_id: "a", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
    } finally {
      close();
    }
  });

  it("node_id with more than one live leaf is a named ambiguous error, runtime never touched", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      audit.append("run-y", { event_type: "leaf.started", sub_id: "leaf-1", node_id: "a" });
      audit.append("run-y", { event_type: "leaf.started", sub_id: "leaf-2", node_id: "a" });
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-y", node_id: "a", message: "hi" }),
      ) as Envelope;
      expect(result.error).toMatch(/sub_id/);
    } finally {
      close();
    }
  });

  it("sub_id that already finished (leaf.completed) is a named error, runtime never touched", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      audit.append("run-z", { event_type: "leaf.started", sub_id: "leaf-1", node_id: "a" });
      audit.append("run-z", { event_type: "leaf.completed", sub_id: "leaf-1", node_id: "a" });
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-z", sub_id: "leaf-1", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
    } finally {
      close();
    }
  });

  it("sub_id unknown to this run is a named error, runtime never touched", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-w", sub_id: "never-spawned", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
    } finally {
      close();
    }
  });

  it("a live leaf whose run has already settled (service has no live runtime) is a named error", async () => {
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      audit.append("run-v", { event_type: "leaf.started", sub_id: "leaf-1", node_id: "a" });
      const settledService = { liveRuntimeOf: (): undefined => undefined };
      const handler = workflowSteerHandler(settledService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-v", node_id: "a", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
    } finally {
      close();
    }
  });

  it("propagates S1's steer_cap refusal (11th pending steer on the SAME busy leaf) as a named error, never queued:true (2ª emenda, #424)", async () => {
    const { runtime, release } = realCoreRuntime();
    const { service, audit, trail, close } = serviceHarness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await flushMicrotasks();
      await trail.flush();

      const workflowSteerHandler = await loadHandler();
      const handler = workflowSteerHandler(service, audit);

      for (let i = 1; i <= 10; i += 1) {
        const accepted = JSON.parse(
          await handler({
            run_id: started.run_id,
            sub_id: "leaf-1",
            message: `STEER-${String(i)}`,
          }),
        ) as Envelope;
        expect(accepted.ok).toBe(true);
        expect(accepted.queued).toBe(true);
      }
      const eleventh = JSON.parse(
        await handler({ run_id: started.run_id, sub_id: "leaf-1", message: "STEER-11" }),
      ) as Envelope;
      expect(eleventh.ok).toBeUndefined();
      expect(eleventh.error).toMatch(/steer_cap/);

      // #444: `leaf.steered` used to be written BEFORE the core decided —
      // 11 events for 10 actually-queued steers. The refused 11th must not
      // reach the ledger at all.
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const steeredEvents = page.events.filter((event) => event.event_type === "leaf.steered");
      expect(steeredEvents).toHaveLength(10);

      release(REAL_COLLECT_RESULT);
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });

  it("resolves by sub_id when the run has more than 100 live leaves — direct identity query, never the 100-event window (#445)", async () => {
    // Regression for #445: `AuditRepository.query` clamps a page to 100
    // events, oldest-seq-first (`src/state/audit-repository.ts:321`,`:395`).
    // The OLD `resolveSubId` fetched a bare `leaf.started` window with NO
    // `subId` filter and just checked membership — so a run with more than
    // 100 live leaves lost every `sub_id` past the 100th to that window,
    // reporting "no live leaf" for a leaf that genuinely exists. The fix
    // queries the ledger BY `sub_id` directly (`AuditQuery.subId` is an
    // exact-identity filter, `audit-repository.ts:118`), which is immune to
    // the window regardless of how many OTHER leaves the run has spawned.
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      for (let i = 1; i <= 120; i += 1) {
        audit.append("run-big", {
          event_type: "leaf.started",
          sub_id: `leaf-${String(i)}`,
          node_id: "a",
        });
      }
      // `liveRuntimeOf` returning `undefined` proves this is a RESOLUTION
      // test, not a delivery test: if resolution had failed, the handler
      // would short-circuit on "no live leaf" and never reach this check.
      const settledService = { liveRuntimeOf: (): undefined => undefined };
      const handler = workflowSteerHandler(settledService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-big", sub_id: "leaf-120", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
      expect(result.error).not.toMatch(/no live leaf/);
      expect(result.error).toMatch(/is not live/);
    } finally {
      close();
    }
  });

  it("node_id resolution above the pagination ceiling is a named 'window truncated' error, distinct from 'no live leaf' (#445)", async () => {
    // Complement to the direct-query fix above: `node_id` resolution still
    // enumerates candidates (ambiguity needs the full live set, not just a
    // membership check), so it paginates with `afterSeq` instead of reading
    // one fixed window. Above `MAX_RESOLUTION_EVENTS` it must say so by name
    // — never silently guess "no live leaf" for a node it never finished
    // reading.
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      const total = 2005;
      for (let i = 1; i <= total; i += 1) {
        audit.append("run-huge", {
          event_type: "leaf.started",
          sub_id: `leaf-${String(i)}`,
          node_id: "b",
        });
      }
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-huge", node_id: "b", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/truncat/i);
      expect(result.error).not.toMatch(/no live leaf/);
    } finally {
      close();
    }
  }, 30_000);

  it("node_id resolution ignores a busy leaf's own tool.* traffic at that node — only leaf.started/completed/failed count against the pagination ceiling (#445)", async () => {
    // A single live leaf that makes hundreds of tool calls emits a
    // `tool.started`/`tool.completed` pair per call, at the SAME node_id
    // (the leaf's own). If `liveSubIdsAtNode` paginated ALL event types at
    // a node instead of one `eventType` per query (the original, pre-#445
    // `scoped()` shape), that traffic alone could exhaust
    // `MAX_RESOLUTION_EVENTS` and report "window truncated" for a node with
    // exactly one, unambiguous live leaf — a regression on the common case.
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      audit.append("run-busy", {
        event_type: "leaf.started",
        sub_id: "leaf-1",
        node_id: "c",
      });
      // Kept under `AUDIT_EVENTS_PER_RUN` (2048, `audit-model.ts`) together
      // with the `leaf.started` above, so retention never prunes it away —
      // 2020 is still comfortably past `MAX_RESOLUTION_EVENTS` (2000) if a
      // node-scoped query counted every event type instead of one.
      for (let i = 1; i <= 2_020; i += 1) {
        audit.append("run-busy", {
          event_type: "tool.started",
          sub_id: "leaf-1",
          node_id: "c",
        });
      }
      // `liveRuntimeOf` returning `undefined` proves this is a RESOLUTION
      // test: had resolution truncated or found the node ambiguous, the
      // handler would short-circuit before ever reaching this check.
      const settledService = { liveRuntimeOf: (): undefined => undefined };
      const handler = workflowSteerHandler(settledService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-busy", node_id: "c", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
      expect(result.error).not.toMatch(/truncat/i);
      expect(result.error).not.toMatch(/no live leaf/);
      expect(result.error).not.toMatch(/ambiguous/);
      expect(result.error).toMatch(/is not live/);
    } finally {
      close();
    }
  }, 30_000);

  it("a repository page reporting has_more with a non-advancing next_after_seq is a named 'window truncated' error, never a silently 'complete' window (#477)", async () => {
    // #477 (found reviewing #466): the defensive "no forward progress"
    // guard in `pagedSubIds` used to return `truncated: false` for exactly
    // the page shape it exists to catch — a repository reporting an
    // INCOMPLETE window (`has_more: true`) whose `next_after_seq` never
    // advances past `after_seq`. Unreachable against the real
    // `AuditRepository` today (its own `next_after_seq` always advances
    // when `has_more` is true — proved by the equivalence tests in
    // `tests/state-audit-repository.test.ts`), but a fake repository can
    // still hand `workflow_steer` exactly this shape, and the tool must
    // fail closed, never report a node's live set as complete.
    const workflowSteerHandler = await loadHandler();
    const stuckPage = {
      run_id: "run-stuck",
      availability: "available" as const,
      filters: {},
      events: [{ identity: { sub_id: "leaf-1" }, event_type: "leaf.started" }],
      page: { after_seq: 0, next_after_seq: 0, snapshot_seq: 1, has_more: true },
      policy: {},
      integrity: {},
    };
    const stuckAudit = { query: () => stuckPage } as unknown as AuditRepository;
    const handler = workflowSteerHandler(unreachableService, stuckAudit);
    const result = JSON.parse(
      await handler({ run_id: "run-stuck", node_id: "a", message: "hi" }),
    ) as Envelope;
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/truncat/i);
  });

  it("resolves exactly 2000 leaf.started events without a false 'window truncated' when the shared budget lands exactly on the ceiling (#477)", async () => {
    // #477: the old top-of-loop budget check (`if (budget.remaining <= 0)
    // return truncated: true`) tripped on the FOLLOWING `pagedSubIds` call
    // (`leaf.completed`) whenever `leaf.started` alone consumed the shared
    // budget down to exactly zero — even though that next call has nothing
    // to read (zero completions) and needs no budget at all. `resolveSubId`
    // must still find the many live leaves this node genuinely has, not
    // report a truncated window it never actually needed to keep reading.
    const workflowSteerHandler = await loadHandler();
    const { audit, close } = auditOnlyHarness();
    try {
      const total = 2_000;
      for (let i = 1; i <= total; i += 1) {
        audit.append("run-exact", {
          event_type: "leaf.started",
          sub_id: `leaf-${String(i)}`,
          node_id: "b",
        });
      }
      const handler = workflowSteerHandler(unreachableService, audit);
      const result = JSON.parse(
        await handler({ run_id: "run-exact", node_id: "b", message: "hi" }),
      ) as Envelope;
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/ambiguous/);
      expect(result.error).not.toMatch(/truncat/i);
    } finally {
      close();
    }
  }, 30_000);

  it("a sub_id the ledger says is live but the real core never spawned (desync) is a named error, never queued:true (2ª emenda, #424)", async () => {
    const { runtime, release } = realCoreRuntime();
    const { service, audit, trail, close } = serviceHarness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await flushMicrotasks();
      await trail.flush();
      audit.append(started.run_id, {
        event_type: "leaf.started",
        sub_id: "ghost-leaf",
        node_id: "a",
      });

      const workflowSteerHandler = await loadHandler();
      const handler = workflowSteerHandler(service, audit);
      const result = JSON.parse(
        await handler({ run_id: started.run_id, sub_id: "ghost-leaf", message: "hi" }),
      ) as Envelope;
      expect(result.ok).toBeUndefined();
      expect(result.error).toMatch(/terminal or unknown/);

      // #444: a steer on an id the core never spawned must leave no trace —
      // this is the "id terminal" case the issue calls out (regression pin:
      // already true on the base, since the decorator's `identities` map
      // never learned this id — kept here so a future regression that
      // records unconditionally on ANY resolved sub_id gets caught too).
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);

      release(REAL_COLLECT_RESULT);
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });
});
