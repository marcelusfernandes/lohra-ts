// Issue #428 (M10-S7): SIGTERM/SIGINT used to converge on the exact same
// `segment.completed {status: "cancelled"}` a plain `workflow_cancel` writes
// — a resume had no way to tell "the operator cancelled this" from "the
// process was told to stop". `WorkflowService.shutdown("signal")` now
// threads that cause through `runShutdown` → `cancelAndSettle` →
// `announceStretchEnd`, so a signal-caused segment closes as
// `{status: "interrupted", reason: "signal"}` while `cancel(runId)` keeps
// naming itself `{status: "cancelled", reason: "cancelled"}`. Molded on
// `tests/workflow-shutdown.test.ts` (not edited — it is t16's `focusFile`)
// and `tests/workflow-audit-segment.test.ts` for the ledger-reading harness.
//
// `registerShutdownTrigger` (`src/cli/shutdown-trigger.ts`) is proved with a
// FAKE `process`-shaped target — never a real OS signal to the vitest
// process itself.
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
import { createWorkflowAuditProducers } from "../src/workflow/audit-producers.js";
import { WorkflowLiveEvents } from "../src/workflow/live-events.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";
import { registerShutdownTrigger, type SignalTarget } from "../src/cli/shutdown-trigger.js";

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

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** A single leaf that stays in flight until `release()` — the window
 * `shutdown()`/`cancel()` need to observe the run as not-yet-settled. */
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
    // Resolves the same gate `collect()` awaits — the engine's own run loop
    // only finishes (and so only then does `announceStretchEnd` fire) once
    // this unblocks, same rationale as `workflow-audit-segment.test.ts`.
    cancel: (): void => {
      open();
    },
    release: (): void => {
      open();
    },
  });
}

function spec(): Record<string, unknown> {
  return { meta: { name: "shutdown-signal" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-signal-"));
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
  const service = new WorkflowService({ runtime, auditTrail: trail, store });
  return {
    service,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

describe("WorkflowService.shutdown('signal') vs cancel() (#428)", () => {
  it("shutdown('signal') with a live run records segment.completed {status: interrupted, reason: signal}", async () => {
    const runtime = gatedRuntime();
    const { service, audit, close } = harness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      await service.shutdown("signal");
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.data).toMatchObject({ status: "interrupted", reason: "signal" });
    } finally {
      close();
    }
  });

  it("shutdown() with no reason (an operator-initiated stop, never a signal) keeps recording plain cancelled, no reason: signal", async () => {
    const runtime = gatedRuntime();
    const { service, audit, close } = harness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      await service.shutdown();
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.data).toMatchObject({ status: "cancelled", reason: "cancelled" });
      expect(segmentDone?.data.reason).not.toBe("signal");
    } finally {
      close();
    }
  });

  it("cancel(runId) records segment.completed {status: cancelled, reason: cancelled} — never reason: signal", async () => {
    const runtime = gatedRuntime();
    const { service, audit, close } = harness(runtime);
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      const out = await service.cancel(started.run_id);
      expect(out).toMatchObject({ run_id: started.run_id, status: "cancelled" });
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.data).toMatchObject({ status: "cancelled", reason: "cancelled" });
    } finally {
      close();
    }
  });

  // Issue #434: `runShutdown` (service.ts:1218-1222) stamps
  // `record.interruptCause = "signal"` on every run still `!settled` at the
  // moment `shutdown("signal")` is called — but a run whose OWN
  // `engine.run()` had already resolved is only marked `settled` inside its
  // `.then()` (:609), a MICROTASK away. A run that wins that race settles
  // with `status: "complete"`, never `"cancelled"`/`"interrupted"` — the
  // guard below is exercised directly through the producers (more honest
  // than reproducing the exact microtask ordering through `WorkflowService`,
  // per the issue): `announceStretchEnd` still receives `cause: "signal"`
  // for such a run, and must ignore it.
  it("announceStretchEnd(status: complete, cause: signal) never grants reason: signal — only cancelled/interrupted do", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-shutdown-signal-race-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const audit = new AuditRepository(connection.database);
    const trail = new AuditTrail(audit);
    try {
      const producers = createWorkflowAuditProducers({
        trail,
        live: new WorkflowLiveEvents(),
        runId: "run-race",
        segmentId: "segment-race",
        ownershipOf: () => null,
        durable: false,
        warn: () => undefined,
        onEvent: undefined,
      });
      producers.announceStretchEnd("complete", null, null, "signal");
      await trail.flush();
      const page = audit.query({ runId: "run-race", limit: 10 });
      const segmentDone = page.events.find((event) => event.event_type === "segment.completed");
      expect(segmentDone?.data).toMatchObject({ status: "complete" });
      expect(segmentDone?.data.reason).toBeUndefined();
    } finally {
      connection.close();
    }
  });
});

describe("registerShutdownTrigger (#428, #434)", () => {
  function fakeProcess(): SignalTarget & {
    readonly listeners: Map<string, Set<() => void>>;
    emit(event: "SIGTERM" | "SIGINT"): void;
  } {
    const listeners = new Map<string, Set<() => void>>();
    return {
      listeners,
      once: (event, handler) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return undefined;
      },
      off: (event, handler) => {
        listeners.get(event)?.delete(handler);
        return undefined;
      },
      emit: (event) => {
        for (const handler of listeners.get(event) ?? []) handler();
      },
    };
  }

  // Issue #434: the entry `registerShutdownTrigger` attaches to the target
  // wraps the caller's `handler` (to disarm the other signal on first fire,
  // below) — the SAME wrapper for both events, never the bare `handler`
  // itself, is what this test proves.
  it("registers the SAME (wrapped) entry for both SIGTERM and SIGINT on a fake target — never the real vitest process", () => {
    const target = fakeProcess();
    const handler = (): void => undefined;
    registerShutdownTrigger(handler, target);
    const sigterm = [...(target.listeners.get("SIGTERM") ?? [])];
    const sigint = [...(target.listeners.get("SIGINT") ?? [])];
    expect(sigterm).toHaveLength(1);
    expect(sigint).toHaveLength(1);
    expect(sigterm[0]).toBe(sigint[0]);
  });

  it("fires the injected handler on a fake SIGTERM delivery", () => {
    const target = fakeProcess();
    let fired = 0;
    registerShutdownTrigger(() => {
      fired += 1;
    }, target);
    target.emit("SIGTERM");
    expect(fired).toBe(1);
  });

  it("unregister removes both listeners — a later fake signal fires nothing", () => {
    const target = fakeProcess();
    let fired = 0;
    const unregister = registerShutdownTrigger(() => {
      fired += 1;
    }, target);
    unregister();
    target.emit("SIGTERM");
    target.emit("SIGINT");
    expect(fired).toBe(0);
    expect(target.listeners.get("SIGTERM")?.size).toBe(0);
    expect(target.listeners.get("SIGINT")?.size).toBe(0);
  });

  // Issue #434: a fake target's `once` (unlike Node's real one) never
  // auto-removes after firing — exactly what makes it catch a handler that
  // fails to disarm the OTHER signal on its own. SIGTERM then SIGINT, with
  // no explicit `unregister()` call in between, must still fire only once.
  it("fires only ONCE total when the fake target delivers SIGTERM then SIGINT, with no unregister() call in between", () => {
    const target = fakeProcess();
    let fired = 0;
    registerShutdownTrigger(() => {
      fired += 1;
    }, target);
    target.emit("SIGTERM");
    target.emit("SIGINT");
    expect(fired).toBe(1);
  });
});
