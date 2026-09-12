// Issue #367: `auditedChildRuntime.installLeafSandbox` hands `inner` a
// WRAPPED installation whose `wrap` produces `tool.started`/`tool.completed`
// for every tool call a leaf makes, keyed by the SAME causal identity
// `leaf.*` (#366) already publishes. Built through `WorkflowService` (real
// sqlite-backed `AuditRepository`/`WorkflowRepository`/`AuditTrail`), same
// posture as `tests/workflow-audit-leaf.test.ts` — this file pins the
// OBSERVABLE contract, not `audit-runtime.ts`'s internals.
//
// Tests drive `installation.wrap`/`onToolSettled` DIRECTLY — the same shape
// `adaptSandboxWrap` (orchestration-runtime.ts) calls them with in
// production — instead of going through `OrchestrationCore`/
// `child-runner.ts`; that seam (subId threading into `wrapDispatch`) is
// `tests/workflow-orchestration-runtime.test.ts`'s job. Each `drive` awaits
// `trail.flush()` itself, INSIDE `collect()`, before the leaf reports
// complete — the same pre-existing async-drain-vs-lease-release race #372's
// test plan documents (audit writes enqueued as a stretch finishes can lose
// the fence the instant `finishStretch()` releases it); flushing while the
// stretch still holds the lease is what a REAL sandbox wrap never needs to
// do (it never enqueues writes on the leaf's own critical path), so this is
// a test-harness accommodation, not a change to the contract under test.
// RED on main `1db43784`: zero `tool.*` events ever reach the ledger (no
// producer wires tool auditing at all).
//
// Issue #378 closes five gaps PR #377 declared without a test — volume (a),
// shutdown-flush (b), a real settle through `adaptSandboxWrap` (c),
// `tool.completed{status:"error"}` from a tool's own failure (d), and
// `unknown_tool` for an MCP name (e) — plus a cancel with a dispatch still
// pending, all below `describe("workflow audit — tool producers (#378)")`.
// (c) is the ONE exception to "never `audit-runtime.ts`'s internals" above:
// `orchestration-runtime.ts`/`src/orchestration/core.ts` are this issue's
// `Files`, but `tests/workflow-orchestration-runtime.test.ts` is not, so the
// seam this file otherwise leaves to that test is exercised here instead,
// directly against `OrchestrationChildRuntime` + `OrchestrationCore`.
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
import type { Timer } from "../src/workflow/durability.js";
import type {
  CausalContext,
  ChildResult,
  ChildRuntime,
  LeafIdentity,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";
import {
  OrchestrationCore,
  type ChildRunner,
  type ChildToolDispatch,
  type CollectResult,
} from "../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import { toolError as envelopeToolError, toolResult } from "../src/tools/envelope.js";
import { workflowToolHandlers } from "../src/workflow/tool.js";

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

/** Captures the installation `WorkflowService.launchDurable` hands over —
 * the AUDITED one, once `auditInstall`'s decorator wraps it — and lets each
 * test drive a leaf's tool calls directly through `installation.wrap`/
 * `onToolSettled` from inside `collect()`, once per leaf, before the leaf
 * reports complete. */
function capturingRuntime(
  drive: (installation: LeafSandboxInstallation, subId: string) => Promise<void>,
): ChildRuntime {
  let installation: LeafSandboxInstallation | null = null;
  let seq = 0;
  return {
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: async (id: string): Promise<ChildResult> => {
      if (installation !== null) await drive(installation, id);
      return { status: "complete", output: { ok: true }, usage: USAGE };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (given: LeafSandboxInstallation): LeafSandboxHandle => {
      installation = given;
      return {
        dispose: () => {
          installation = null;
        },
      };
    },
  };
}

function spec(): Record<string, unknown> {
  return { meta: { name: "audit-tool" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

/** Real sqlite-backed durable store — exactly the composition
 * `WorkflowService` sees in production. `makeRuntime` receives the `trail`
 * up front, so a test's `drive` closure can flush it itself; `options`
 * (#378) let a test shrink the retention cap or inject a controllable
 * `timerFactory` for `cancel()`/`shutdown()`'s settle ceiling. */
function harness(
  makeRuntime: (trail: AuditTrail) => ChildRuntime,
  options: {
    readonly maxEventsPerRun?: number;
    readonly timerFactory?: (delay: number, fire: () => void) => Timer;
  } = {},
): {
  readonly service: WorkflowService;
  readonly repository: WorkflowRepository;
  readonly audit: AuditRepository;
  readonly trail: AuditTrail;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-"));
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
    runtime: makeRuntime(trail),
    auditTrail: trail,
    store,
    ...(options.timerFactory === undefined ? {} : { timerFactory: options.timerFactory }),
  });
  return {
    service,
    repository,
    audit,
    trail,
    close: (): void => {
      connection.close();
    },
  };
}

/** A single leaf whose `collect()` stays pending until `release()` — the
 * window `cancel()`/`shutdown()` need to observe it as not-yet-settled —
 * while still capturing the AUDITED installation so a test can drive a tool
 * dispatch through it directly, the same shape `capturingRuntime` above
 * uses. `onCollect` runs exactly once, synchronously, before `collect()`
 * awaits the gate — issue #378's cancel/shutdown-with-a-pending-dispatch
 * tests. The leaf's own `cancel()` is a no-op: only the DECORATOR's
 * bookkeeping (`close()`, audit-runtime.ts) closes the leaf AND any tool
 * dispatch still open on it. */
function gatedToolRuntime(
  onCollect: (installation: LeafSandboxInstallation, subId: string) => void,
): ChildRuntime & { release(): void } {
  let openGate!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    openGate = resolveGate;
  });
  let installation: LeafSandboxInstallation | null = null;
  let driven = false;
  return {
    spawn: (): string => "leaf-1",
    collect: async (id: string): Promise<ChildResult> => {
      if (!driven && installation !== null) {
        driven = true;
        onCollect(installation, id);
      }
      await gate;
      return { status: "complete", output: { ok: true }, usage: USAGE };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (given: LeafSandboxInstallation): LeafSandboxHandle => {
      installation = given;
      return {
        dispose: () => {
          installation = null;
        },
      };
    },
    release: (): void => {
      openGate();
    },
  };
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  const value = row.audit_segment_id;
  expect(typeof value).toBe("string");
  return value as string;
}

describe("workflow audit — tool producers (#367)", () => {
  it('a call the sandbox lets through: tool.started then tool.completed{status:"success"} from onToolSettled; a call it denies: tool.completed{status:"error", reason:"sandbox_denied"} right after tool.started, no onToolSettled needed', async () => {
    const ref: { service: WorkflowService | null; runId: string } = { service: null, runId: "" };
    const { service, repository, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const owner = ref.service;
        if (owner === null) throw new Error("service not ready");
        const workingRoot = owner.workingRootFor(ref.runId);
        const base: LeafToolDispatch = (name, args) =>
          `{"ok":true,"echo":"${name}:${String(Object.keys(args).length)}"}`;
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);

        // inside the leaf's own working root — allowed regardless of
        // operator policy (sandbox.ts:fsDenial always includes workingRoot).
        const allowedOut = dispatch("read_file", { path: join(workingRoot, "note.txt") });
        expect(allowedOut).toMatch(/^\{"ok":true/);
        installation.onToolSettled?.(leaf, true);

        // outside every root — denied fail-closed before base is reached.
        const deniedOut = dispatch("write_file", { path: "/definitely/outside/every/root.txt" });
        expect(deniedOut).toMatch(/^ERROR: /);
        await trail.flush();
      }),
    );
    ref.service = service;
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual([
        "tool.started",
        "tool.completed",
        "tool.started",
        "tool.completed",
      ]);
      for (const event of tools) {
        expect(event.identity.segment_id).toBe(segmentId);
        expect(event.identity.sub_id).toBe("leaf-1");
      }
      expect(tools[0]?.data.tool_name_state).toBe("known_tool");
      expect(tools[0]?.data.fields).toBe(1);
      expect(tools[1]?.data.status).toBe("success");
      expect(tools[1]?.data.reason).toBeUndefined();
      expect(tools[3]?.data.status).toBe("error");
      expect(tools[3]?.data.reason).toBe("sandbox_denied");
    } finally {
      close();
    }
  });

  it("a name outside the builtin catalog is classified unknown_tool and still reaches the real dispatch", async () => {
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        const out = dispatch("totally_made_up_tool_37", { a: 1, b: 2 });
        expect(out).toBe('{"ok":true}');
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[0]?.data.tool_name_state).toBe("unknown_tool");
      expect(tools[0]?.data.fields).toBe(2);
      expect(tools[1]?.data.status).toBe("success");
    } finally {
      close();
    }
  });

  it("sanitization: a unicode canary in the tool name and in an argument value never reaches a tool.* payload", async () => {
    const nameCanary = "UNICODE-CANARY-\u{1F512}-TOOL-NAME";
    const argCanary = "UNICODE-CANARY-\u{1F513}-ARG-VALUE";
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        dispatch(nameCanary, { secret: argCanary });
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.length).toBeGreaterThan(0);
      const rendered = JSON.stringify(tools);
      expect(rendered).not.toContain(nameCanary);
      expect(rendered).not.toContain(argCanary);
      expect(tools[0]?.data.tool_name_state).toBe("unknown_tool");
    } finally {
      close();
    }
  });

  it("fail-closed: tool.* produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger — a call made BEFORE the eviction does, and a warn names the drop", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-eviction-"));
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
      const runtime = capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        dispatch("before_eviction_tool", {});
        installation.onToolSettled?.(leaf, true);
        await trail.flush();

        const owner = running.service;
        if (!evicted && owner !== null) {
          evicted = true;
          const second = owner.start(spec());
          if ("error" in second) throw new Error(second.error);
        }

        dispatch("after_eviction_tool", {});
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
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
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(
        warnings.some((message) => message.includes("ownership lost") && message.includes("tool.")),
      ).toBe(true);
    } finally {
      connection.close();
    }
  });
});

function timerRecorder(): {
  readonly timers: { fire(): void }[];
  readonly timerFactory: (delay: number, fire: () => void) => Timer;
} {
  const timers: { fire(): void }[] = [];
  return {
    timers,
    timerFactory: (_delay: number, fire: () => void): Timer => {
      timers.push({ fire });
      return { cancel: (): void => undefined };
    },
  };
}

describe("workflow audit — tool producers, PR #377's declared gaps (#378)", () => {
  it('cancel with a dispatch still pending: tool.completed{status:"error",reason:"cancelled"} closes the orphan BEFORE leaf.failed', async () => {
    const { timers, timerFactory } = timerRecorder();
    const ref: { service: WorkflowService | null; runId: string } = { service: null, runId: "" };
    const runtime = gatedToolRuntime((installation, id) => {
      const owner = ref.service;
      if (owner === null) throw new Error("service not ready");
      const workingRoot = owner.workingRootFor(ref.runId);
      const base: LeafToolDispatch = () => '{"ok":true}';
      const leaf: LeafIdentity = { subId: id };
      const dispatch = installation.wrap(base, leaf);
      // inside the leaf's own working root — reaches the real dispatch,
      // never settled: the "dispatch still pending" this test is about.
      dispatch("read_file", { path: join(workingRoot, "note.txt") });
    });
    const { service, audit, trail, close } = harness(() => runtime, { timerFactory });
    ref.service = service;
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const armedBefore = timers.length; // the lease heartbeat, armed on acquisition
      const done = Promise.resolve(service.cancel(started.run_id));
      expect(timers.length).toBe(armedBefore + 1); // the settle ceiling, armed synchronously
      timers[timers.length - 1]?.fire(); // the leaf is still gated — the ceiling elapses
      await done;
      await trail.flush();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[1]?.data).toMatchObject({ status: "error", reason: "cancelled" });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.failed"]);
      // the orphan's tool.completed is ordered BEFORE the leaf's own terminal.
      const toolCompletedSeq = tools[1]?.seq ?? Number.POSITIVE_INFINITY;
      const leafFailedSeq = leaves[1]?.seq ?? -1;
      expect(toolCompletedSeq).toBeLessThan(leafFailedSeq);
      runtime.release();
    } finally {
      close();
    }
  });

  it("shutdown() flushes: one settled and one still-pending tool.* on the same leaf both land in the ledger once shutdown() resolves, with no explicit trail.flush()", async () => {
    const { timers, timerFactory } = timerRecorder();
    const ref: { service: WorkflowService | null; runId: string } = { service: null, runId: "" };
    const runtime = gatedToolRuntime((installation, id) => {
      const owner = ref.service;
      if (owner === null) throw new Error("service not ready");
      const workingRoot = owner.workingRootFor(ref.runId);
      const base: LeafToolDispatch = () => '{"ok":true}';
      const leaf: LeafIdentity = { subId: id };
      const dispatch = installation.wrap(base, leaf);
      dispatch("read_file", { path: join(workingRoot, "settled.txt") });
      installation.onToolSettled?.(leaf, true); // settles before shutdown
      dispatch("read_file", { path: join(workingRoot, "pending.txt") }); // never settles
    });
    const { service, audit, close } = harness(() => runtime, { timerFactory });
    ref.service = service;
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      ref.runId = started.run_id;
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const done = service.shutdown();
      timers[timers.length - 1]?.fire(); // the settle ceiling, armed synchronously
      await done; // shutdown()'s own auditTrail.shutdown() flush — no trail.flush() here
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual([
        "tool.started",
        "tool.completed",
        "tool.started",
        "tool.completed",
      ]);
      expect(tools[1]?.data).toMatchObject({ status: "success" });
      expect(tools[1]?.data.reason).toBeUndefined();
      expect(tools[3]?.data).toMatchObject({ status: "error", reason: "cancelled" });
      const leaves = page.events.filter((event) => event.event_type.startsWith("leaf."));
      expect(leaves.map((event) => event.event_type)).toEqual(["leaf.started", "leaf.failed"]);
      runtime.release();
    } finally {
      close();
    }
  });

  it("volume: 500 tool calls beyond a small retention cap prune without crashing or reordering, and record audit.gap{retention_limit}", async () => {
    const { service, audit, close } = harness(
      (trail) =>
        capturingRuntime(async (installation, id) => {
          const base: LeafToolDispatch = () => '{"ok":true}';
          const leaf: LeafIdentity = { subId: id };
          const dispatch = installation.wrap(base, leaf);
          for (let index = 0; index < 500; index += 1) {
            dispatch(`tool_${String(index)}`, {});
            installation.onToolSettled?.(leaf, true);
            // stay well under AUDIT_QUEUE_CAPACITY (256, audit-model.ts) so
            // this proves DURABLE retention pruning, never in-memory
            // backpressure (queue_overflow) masking it.
            if (index % 50 === 49) await trail.flush();
          }
          await trail.flush();
        }),
      { maxEventsPerRun: 20 },
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 200 });
      expect(page.events.length).toBeLessThanOrEqual(20);
      const seqs = page.events.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right)); // never out of order
      const notices = page.integrity.notices as readonly Readonly<Record<string, unknown>>[];
      const gapReasons = notices
        .filter((notice) => notice.event_type === "audit.gap")
        .map((notice) => (notice.data as Readonly<Record<string, unknown>> | undefined)?.reason);
      expect(gapReasons).toContain("retention_limit");
      expect(gapReasons).not.toContain("queue_overflow");
    } finally {
      close();
    }
  });

  it('a tool call that reaches the real dispatch but the tool itself fails: tool.completed{status:"error"} from onToolSettled(false), no reason — distinct from a sandbox denial', async () => {
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"error":"boom"}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        const out = dispatch("a_tool_that_fails", {});
        expect(out).toBe('{"error":"boom"}');
        installation.onToolSettled?.(leaf, false); // the tool itself failed, never a sandbox denial
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[1]?.data.status).toBe("error");
      expect(tools[1]?.data.reason).toBeUndefined();
    } finally {
      close();
    }
  });

  it("an MCP tool's real name (mcp_*) is always classified unknown_tool here — no per-run registry reaches this decorator", async () => {
    const { service, audit, close } = harness((trail) =>
      capturingRuntime(async (installation, id) => {
        const base: LeafToolDispatch = () => '{"ok":true}';
        const leaf: LeafIdentity = { subId: id };
        const dispatch = installation.wrap(base, leaf);
        const out = dispatch("mcp_myserver_search", { query: "x" });
        expect(out).toBe('{"ok":true}');
        installation.onToolSettled?.(leaf, true);
        await trail.flush();
      }),
    );
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const tools = page.events.filter((event) => event.event_type.startsWith("tool."));
      expect(tools.map((event) => event.event_type)).toEqual(["tool.started", "tool.completed"]);
      expect(tools[0]?.data.tool_name_state).toBe("unknown_tool");
    } finally {
      close();
    }
  });
});

function orchestrationCollectResult(output: string): CollectResult {
  return {
    status: "complete",
    output,
    tokensIn: 1,
    tokensOut: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    provider: "test",
    model: "test-model",
    errorKind: null,
    retryAfter: null,
  };
}

function orchestrationCoreFor(runChild: ChildRunner): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild,
    idSource: () => {
      n += 1;
      return `settle-leaf-${String(n)}`;
    },
    maxSubsessions: 100,
    maxParallel: 10,
    buildSubagentPrompt: () => "SYS",
  });
}

function orchestrationCausal(runId: string): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["a"]),
    cellId: "a:0",
    role: "leaf",
    attempt: 0,
    turn: 0,
  });
}

// Issue #378, gap (c): `tests/workflow-audit-tool.test.ts` is this issue's
// `Files`, `tests/workflow-orchestration-runtime.test.ts` is not — so the
// `adaptSandboxWrap` settle seam (orchestration-runtime.ts:63-79) gets its
// unit test here, directly against `OrchestrationChildRuntime` +
// `OrchestrationCore`, never through the ledger.
describe("adaptSandboxWrap — settle real (#378, orchestration-runtime.ts:63-79)", () => {
  it("awaits the async base dispatch and calls onToolSettled with ok parsed from a REAL tool envelope (src/tools/envelope.ts), never a hand-rolled string", async () => {
    // the heuristic under test (`okFromEnvelope`) parses only the envelope's
    // own leading bytes — pin that the REAL success serializer produces them.
    expect(toolResult({}).startsWith('{"ok":true')).toBe(true);
    expect(envelopeToolError("boom").startsWith('{"ok":true')).toBe(false);

    let captured: ((base: ChildToolDispatch, subId: string) => ChildToolDispatch) | undefined;
    const runChild: ChildRunner = (_subId, config) => {
      captured = config.wrapDispatch;
      return Promise.resolve(orchestrationCollectResult("done"));
    };
    const runtime = new OrchestrationChildRuntime(orchestrationCoreFor(runChild));
    const settled: { subId: string; ok: boolean }[] = [];
    runtime.installLeafSandbox({
      runId: "r-settle",
      fence: 1,
      // identity policy — never denies, forwards straight through to base.
      wrap: (base) => base,
      onToolSettled: (leaf, ok) => settled.push({ subId: leaf.subId, ok }),
    });
    const id = runtime.spawn({ prompt: "do it", causalContext: orchestrationCausal("r-settle") });
    // ConcurrencyGate.run() only actually calls runChild on a later
    // microtask — collect(wait:true) is the honest way to wait for it.
    await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    if (captured === undefined) throw new Error("wrapDispatch missing");

    const okBase: ChildToolDispatch = (name) => Promise.resolve(toolResult({ echo: name }));
    const okOut = await captured(okBase, id)("read_file", {});
    expect(okOut).toBe(toolResult({ echo: "read_file" }));
    expect(settled).toEqual([{ subId: id, ok: true }]);

    const failBase: ChildToolDispatch = () => Promise.resolve(envelopeToolError("boom"));
    const failOut = await captured(failBase, id)("read_file", {});
    expect(failOut).toBe(envelopeToolError("boom"));
    expect(settled).toEqual([
      { subId: id, ok: true },
      { subId: id, ok: false },
    ]);
  });
});

// Issue #373: `workflow_audit` in the SAME turn as `run_workflow` used to be
// able to race the trail's async drain and read back `events: []` — remeasured
// on main `9a966934` (already carrying #379's flush-before-release fix,
// #368) and the FIRST scenario below was already green: `flushBeforeRelease`
// runs before `finishStretch()` releases the lease, so by the time
// `workflow_status(wait:true)` resolves the run's own events are already
// durable. What was still silent was a drain that never finishes at all (a
// permanently-busy sink) — the SECOND scenario, through the actual
// `workflow_audit` TOOL handler (`workflowToolHandlers`, not `audit.query`
// directly), which is what this issue's `pending` field closes.
describe("workflow audit — same-turn read after run_workflow (#373)", () => {
  it("run_workflow → workflow_status(wait) → workflow_audit in the same turn returns the run's own events, never events: [] (already true on main since #379)", async () => {
    const { service, audit, close } = harness(() => ({
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({
        status: "complete",
        output: { ok: true },
        usage: USAGE,
      }),
      steer: () => undefined,
      cancel: () => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
    }));
    try {
      const handlers = workflowToolHandlers(service, audit);
      const runOut = await handlers.run_workflow?.({ spec: spec() });
      const runJson = JSON.parse((runOut ?? "").replace(/^ERROR: /, "")) as { run_id: string };
      await handlers.workflow_status?.({ run_id: runJson.run_id, wait: true });
      const auditOut = await handlers.workflow_audit?.({ run_id: runJson.run_id, limit: 50 });
      const parsed = JSON.parse(auditOut ?? "{}") as {
        events: readonly unknown[];
        integrity?: { pending?: number };
      };
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.integrity?.pending ?? 0).toBe(0);
    } finally {
      close();
    }
  });

  it("a drain stuck on a permanently-busy sink reports integrity.pending instead of a silent events: []", async () => {
    let attempts = 0;
    const stuckRepository = {
      append: (): never => {
        attempts += 1;
        throw new Error("database is locked");
      },
      isBusyError: () => true,
    } as unknown as AuditRepository;
    const trail = new AuditTrail(stuckRepository, {
      retryLimit: 5,
      retryDelayMs: 0,
      // never resolves: the stuck drain this test is about — a real busy
      // sink that never clears, not merely a bounded number of retries.
      sleep: () => new Promise<void>(() => undefined),
    });
    trail.record("stuck-run", { event_type: "node.started" });
    trail.record("stuck-run", { event_type: "node.started" });
    trail.record("stuck-run", { event_type: "node.started" });

    const root = mkdtempSync(join(tmpdir(), "lohra-audit-tool-pending-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const readableAudit = new AuditRepository(connection.database);
      const service = new WorkflowService({
        runtime: {
          spawn: (): string => "unused",
          collect: (): ChildResult => ({
            status: "complete",
            output: null,
            usage: USAGE,
          }),
          steer: () => undefined,
          cancel: () => undefined,
        },
        auditTrail: trail,
      });
      const handlers = workflowToolHandlers(service, readableAudit);
      const out = await handlers.workflow_audit?.({ run_id: "stuck-run", limit: 50 });
      const parsed = JSON.parse(out ?? "{}") as {
        events: readonly unknown[];
        integrity: { pending?: number };
      };
      expect(parsed.events).toEqual([]);
      expect(parsed.integrity.pending).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(0);
    } finally {
      connection.close();
    }
  });
});
