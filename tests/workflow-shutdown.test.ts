import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { AuditRepository } from "../src/state/audit-repository.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";
import type { Timer } from "../src/workflow/durability.js";

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
    runtime.release(); // let the still-in-flight leaf settle before the test ends
  });
});
