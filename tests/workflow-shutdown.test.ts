import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { AuditRepository } from "../src/state/audit-repository.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";
import type { Timer } from "../src/workflow/durability.js";
import { orchestrationMutants } from "../scripts/mutations/orchestration.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A leaf that stays in flight until `release()` is called — the window a
 * live run needs for `shutdown()` to observe it as not-yet-settled. */
function gatedRuntime(): ChildRuntime & { release(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return {
    spawn: (): string => "leaf-1",
    collect: async (): Promise<ChildResult> => {
      await gate;
      return {
        status: "complete",
        output: { answer: "ok" },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      };
    },
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: () => ({ dispose: (): void => undefined }),
    release: (): void => {
      open();
    },
  };
}

function spec(): Record<string, unknown> {
  return { meta: { name: "shutdown" }, nodes: [{ id: "a", type: "agent", prompt: "do it" }] };
}

/** N leaves, each gated on its OWN promise — the window `cancel()` needs to
 * prove it waits for every one of them, not just the first (issue #233). */
function multiGatedRuntime(): ChildRuntime & { release(id: string): void; spawned: string[] } {
  const open = new Map<string, () => void>();
  const gate = new Map<string, Promise<void>>();
  const spawned: string[] = [];
  return {
    spawn: (): string => {
      const id = `leaf-${String(spawned.length + 1)}`;
      spawned.push(id);
      gate.set(
        id,
        new Promise((resolveGate) => {
          open.set(id, resolveGate);
        }),
      );
      return id;
    },
    collect: async (id: string): Promise<ChildResult> => {
      await gate.get(id);
      return {
        status: "complete",
        output: { answer: "ok" },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      };
    },
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: () => ({ dispose: (): void => undefined }),
    release: (id: string): void => {
      open.get(id)?.();
    },
    spawned,
  };
}

function parallelSpec(): Record<string, unknown> {
  return {
    meta: { name: "cancel-quiescente" },
    nodes: [{ id: "p", type: "parallel", branches: ["one", "two"] }],
  };
}

/** Real sqlite-backed store, plus a `timerFactory` that hands every armed
 * timer back so a test can fire one by hand. */
function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const timers: { delay: number; fire(): void; cancelled: boolean }[] = [];
  const timerFactory = (delay: number, fire: () => void): Timer => {
    const timer = { delay, fire, cancelled: false };
    timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };
  const service = new WorkflowService({
    runtime,
    timerFactory,
    store: {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    },
  });
  return {
    service,
    repository,
    locks,
    timers,
    close: () => {
      connection.close();
    },
  };
}

describe("WorkflowService.shutdown()", () => {
  it("stops the lease heartbeat: a timer fired by hand after shutdown never renews", async () => {
    const runtime = gatedRuntime();
    const { service, locks, timers, close } = harness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      expect(timers.length).toBe(1); // the heartbeat, armed on acquisition
      const renewSpy = vi.spyOn(locks, "renewRunLease");
      const done = service.shutdown();
      // heartbeat.shutdown() runs synchronously inside shutdown()'s sync
      // prefix, before the first await — the timer is already dead here.
      timers[0]?.fire();
      expect(renewSpy).not.toHaveBeenCalled();
      runtime.release();
      await done;
    } finally {
      close();
    }
  });

  it("a run cancelled by shutdown() resumes via resume_run_id with no busyErrorMessage", async () => {
    const runtime = gatedRuntime();
    const { service, locks, close } = harness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const done = service.shutdown();
      runtime.release();
      await done;
      expect(locks.runLeaseExpiry(started.run_id, 1000)).toBeNull();
      const resumed = service.start(spec(), {}, { resumeRunId: started.run_id });
      expect(resumed).not.toHaveProperty("error");
      expect(resumed).toMatchObject({ run_id: started.run_id, status: "started" });
    } finally {
      close();
    }
  });

  it("is idempotent: concurrent shutdown() calls share one run, auditTrail.shutdown fires once", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-idempotent-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const auditTrail = new AuditTrail(new AuditRepository(connection.database));
      const shutdownSpy = vi.spyOn(auditTrail, "shutdown");
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const service = new WorkflowService({
        runtime: gatedRuntime(),
        auditTrail,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const [first, second] = await Promise.all([service.shutdown(), service.shutdown()]);
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(shutdownSpy).toHaveBeenCalledTimes(1);
      await service.shutdown();
      expect(shutdownSpy).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
    }
  });

  it("flushes and closes the audit trail: record() after shutdown() is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-audit-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const auditRepository = new AuditRepository(connection.database);
      const auditTrail = new AuditTrail(auditRepository);
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const service = new WorkflowService({
        runtime: gatedRuntime(),
        auditTrail,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      await service.shutdown();
      expect(auditTrail.record("some-run", { event_type: "workflow.plan" })).toBe(false);
    } finally {
      connection.close();
    }
  });

  // Issue #121, AC 3: runShutdown had `this.warn` at hand but discarded the
  // boolean auditTrail.shutdown() returns — a failed flush was silent unless
  // the caller had ALSO wired AuditTrail's own `warning` option (chat.ts and
  // dashboard.ts leave it at the default no-op).
  it("warns via this.warn when the audit trail's flush fails on shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-audit-warn-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const auditTrail = new AuditTrail(new AuditRepository(connection.database));
      vi.spyOn(auditTrail, "shutdown").mockResolvedValue(false);
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const warnings: string[] = [];
      const service = new WorkflowService({
        runtime: gatedRuntime(),
        auditTrail,
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
      await service.shutdown();
      expect(warnings.some((message) => message.includes("audit trail flush failed"))).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("warns once when store is undefined outside a test environment", () => {
    const warnings: string[] = [];
    const service = new WorkflowService({
      runtime: {
        spawn: () => "leaf",
        collect: () => ({ status: "complete", output: "ok" }),
        steer: () => undefined,
        cancel: () => undefined,
      },
      onWarning: (message) => warnings.push(message),
      environment: {},
      idSource: () => "ephemeral-warn",
    });
    service.start(spec());
    service.start(spec(), {}, { resumeRunId: "ephemeral-warn-2" });
    expect(warnings.filter((message) => message.includes("without a durable store"))).toHaveLength(
      1,
    );
  });

  it("does not warn about the ephemeral branch inside a test environment", () => {
    const warnings: string[] = [];
    const service = new WorkflowService({
      runtime: {
        spawn: () => "leaf",
        collect: () => ({ status: "complete", output: "ok" }),
        steer: () => undefined,
        cancel: () => undefined,
      },
      onWarning: (message) => warnings.push(message),
      environment: { VITEST: "true" },
      idSource: () => "ephemeral-no-warn",
    });
    service.start(spec());
    expect(warnings.some((message) => message.includes("without a durable store"))).toBe(false);
  });

  // Issue #121, AC 1: runShutdown's ceiling is now the CONSTRUCTOR's own
  // timerFactory (defaulting to the real clock), not the module-level
  // defaultServiceTimer — a store is not required to observe it, so this
  // stays free of sqlite. Asserting the armed delay as the literal `5`
  // (never SHUTDOWN_SETTLE_TIMEOUT_MS / 1000) is what catches the constant
  // being mutated to 0: importing it would mutate both sides together.
  it("hits the shutdown ceiling: a live run that never settles fires the timed-out warning", async () => {
    const timers: { delay: number; fire(): void; cancelled: boolean }[] = [];
    const timerFactory = (delay: number, fire: () => void): Timer => {
      const timer = { delay, fire, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    };
    const warnings: string[] = [];
    const runtime = gatedRuntime();
    const service = new WorkflowService({
      runtime,
      timerFactory,
      onWarning: (message) => warnings.push(message),
      environment: { VITEST: "true" },
      idSource: () => "ceiling-run",
    });
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    expect(timers.length).toBe(0); // no heartbeat/auto-resume without a store
    const done = service.shutdown();
    // The ceiling timer is armed synchronously, inside shutdown()'s sync
    // prefix, before the first await (same as the heartbeat's own timer).
    expect(timers.length).toBe(1);
    expect(timers[0]?.delay).toBe(5);
    timers[0]?.fire(); // the leaf is still gated — this is the "timed out" branch
    await done;
    expect(
      warnings.some(
        (message) => message.includes("shutdown timed out") && message.includes("1 run"),
      ),
    ).toBe(true);
    // Issue #275: PR #289 dropped this half of the warning while sharing the
    // settle-wait with cancel() — restored, self-contained (not a dangling
    // pronoun off the first warning).
    expect(warnings.some((message) => message.includes("heartbeat already stopped"))).toBe(true);
    runtime.release(); // let the still-in-flight leaf settle before the test ends
  });
});

// Issue #233: cancel() used to answer 'cancelled' the instant it was called,
// while leaves already in flight kept spending tokens until their OWN
// timeout — engine.cancel() now signals them (like noteQuotaExhausted) and
// service.cancel() waits for quiescence with shutdown()'s own ceiling.
describe("WorkflowService.cancel() waits for quiescence (#233)", () => {
  it("parallel with leaves in flight: cancel() only resolves once every leaf settles, and spawns no more", async () => {
    const runtime = multiGatedRuntime();
    const service = new WorkflowService({
      runtime,
      environment: { VITEST: "true" },
      idSource: () => "cancel-parallel",
    });
    const started = service.start(parallelSpec());
    if ("error" in started) throw new Error(started.error);
    // Let both branches actually spawn and block on their own gate before cancelling.
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(runtime.spawned).toEqual(["leaf-1", "leaf-2"]);
    let settled = false;
    const done = Promise.resolve(service.cancel(started.run_id)).then((out) => {
      settled = true;
      return out;
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(settled).toBe(false); // both leaves are still gated — cancel() must still be waiting
    runtime.release("leaf-1");
    runtime.release("leaf-2");
    const out = await done;
    expect(out).toMatchObject({ run_id: started.run_id, status: "cancelled" });
    expect(runtime.spawned).toEqual(["leaf-1", "leaf-2"]); // no leaf spawned after cancel
  });

  it("a leaf that ignores cancel: reports 'cancelling' with leaves_in_flight; 'cancelled' lands only once it later settles", async () => {
    const timers: { delay: number; fire(): void; cancelled: boolean }[] = [];
    const timerFactory = (delay: number, fire: () => void): Timer => {
      const timer = { delay, fire, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    };
    const warnings: string[] = [];
    const runtime = gatedRuntime(); // its cancel() is a no-op: the leaf ignores the signal
    const service = new WorkflowService({
      runtime,
      timerFactory,
      onWarning: (message) => warnings.push(message),
      environment: { VITEST: "true" },
      idSource: () => "cancel-ignoring",
    });
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    // Let the leaf actually spawn and block on its own gate before cancelling.
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    const done = Promise.resolve(service.cancel(started.run_id));
    expect(timers.length).toBe(1); // the settle ceiling, armed synchronously
    timers[0]?.fire(); // 5s elapse; the leaf is still gated
    const out = await done;
    expect(out).toMatchObject({
      run_id: started.run_id,
      status: "cancelling",
      leaves_in_flight: 1,
    });
    expect(
      warnings.some((message) => message.includes("cancel of run") && message.includes("1 run")),
    ).toBe(true);
    const stillRunning = await service.status(started.run_id, false);
    expect(stillRunning).not.toMatchObject({ status: "cancelled" });
    runtime.release();
    const settledStatus = await service.status(started.run_id, true);
    expect(settledStatus).toMatchObject({ status: "cancelled" });
  });

  // Issue #275: cancel() used to answer 'cancelled' whenever cancelAndSettle
  // settled in time, even for a run this call found ALREADY published under
  // a different terminal status — the zero-width edge of the settle window,
  // deterministic here because the ephemeral (storeless) path never deletes
  // a settled record from `this.runs`.
  it("cancel() on an already-settled run reports what it actually published, not a hardcoded 'cancelled'", async () => {
    const service = new WorkflowService({
      runtime: {
        spawn: () => "leaf",
        collect: () => ({ status: "complete", output: "ok" }),
        steer: () => undefined,
        cancel: () => undefined,
      },
      environment: { VITEST: "true" },
      idSource: () => "cancel-already-settled",
    });
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true); // wait for it to settle to "complete"
    const out = await service.cancel(started.run_id);
    expect(out).toMatchObject({ run_id: started.run_id, status: "complete" });
  });
});

// Issue #129 — follow-up to #121/PR #127's review (reason 4): the ceiling
// test just above pins `timers[0]?.delay` to the literal `5`, which already
// kills a mutant that collapses SHUTDOWN_SETTLE_TIMEOUT_MS to 0 whenever
// `npm test` runs — but until now `mutations:t16`'s own catalog
// (`mutants-orchestration.ts`) had no entry saying so, so that mutant was
// only ever dead by the suite, never by the harness (the same gap #112
// closed for child-runner.ts's wrap wiring). Molded on
// `tests/orchestration-child-runner-mutation-catalog.test.ts`: pins the
// mutant's `before` as exact source text, so a drift in service.ts fails
// here before the slower `npm run mutations:t16` ever runs.
const serviceSource = readFileSync(resolve(__dirname, "..", "src/workflow/service.ts"), "utf8");

const SHUTDOWN_CEILING_MUTANT_ID = "ao/shutdown-ceiling-collapses-to-zero";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mutations:t16 catalog pins service.ts's SHUTDOWN_SETTLE_TIMEOUT_MS (#129)", () => {
  const mutant = orchestrationMutants.find(
    (candidate) => candidate.id === SHUTDOWN_CEILING_MUTANT_ID,
  );

  it(`mutants-orchestration.ts declares ${SHUTDOWN_CEILING_MUTANT_ID}`, () => {
    expect(mutant).toBeDefined();
  });

  it(`${SHUTDOWN_CEILING_MUTANT_ID}'s pinned "before" occurs exactly once, verbatim, in service.ts`, () => {
    const before = mutant?.edits[0]?.before ?? "";
    expect(before.length).toBeGreaterThan(0);
    expect(occurrences(serviceSource, before)).toBe(1);
  });

  it(`${SHUTDOWN_CEILING_MUTANT_ID}'s focus names this file's shutdown-ceiling test`, () => {
    expect(mutant?.focus.file).toBe("tests/workflow-shutdown.test.ts");
    expect(mutant?.focus.test).toBe(
      "hits the shutdown ceiling: a live run that never settles fires the timed-out warning",
    );
  });
});
