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
    // Declared `void` (the port), but returns a real `core.steer`-shaped
    // outcome at runtime — same "declared void, real value" posture
    // `OrchestrationChildRuntime.steer` itself now uses (issue #424, 2ª
    // emenda), so `workflow_steer`'s runtime shape check has something
    // real to recover here too.
    steer: (id: string, prompt: string): void => {
      steered.push({ id, prompt });
      return { queued: true } as unknown as undefined;
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

      release(REAL_COLLECT_RESULT);
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });

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

      release(REAL_COLLECT_RESULT);
      await service.status(started.run_id, true);
    } finally {
      close();
    }
  });
});
