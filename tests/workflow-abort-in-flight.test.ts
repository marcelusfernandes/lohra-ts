// Issue #518 (M16-S3, épico #490, ADR 0005): `workflow_cancel` (or
// `shutdown()`) during a leaf's own stream now tears the call down IN
// FLIGHT instead of leaving it to run to completion — `WorkflowService` +
// a REAL `OrchestrationChildRuntime` (over `OrchestrationCore` +
// `createChildRunner`, with a fake `ChatHttpPort` standing in for the real
// socket, never a hand-rolled `ChildRuntime` double) is the composition
// production actually wires (`commands/chat.ts:369`,
// `commands/dashboard.ts:333`). RED on main (167c2669): the leaf settles
// "interrupted" with `errorKind: null`/`usageUncertain: true`/no `partial`
// at all — this issue's `child-runner.ts` catch branch is what produces the
// real, non-zero estimated usage this file pins.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { getProviderProfile } from "../src/providers/index.js";
import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  SessionRepository,
  WorkflowRepository,
} from "../src/state/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import { OrchestrationCore } from "../src/orchestration/core.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { auditedRuntimeFor } from "../src/workflow/audit-runtime.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type { CausalContext } from "../src/workflow/runtime.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";

const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** Same handshake as `orchestration-child-runner-abort.test.ts`: `post()`
 * signals `onStarted()` synchronously, so a test can wait for the real
 * HTTP-level request before aborting — never a synchronous abort right
 * after `service.start(...)` returns, which would race the pre-issuance
 * check instead of exercising the in-flight path. `buildError` receives the
 * partial SSE bytes to embed, so the CALLER (inside `it()`) decides the
 * exact error shape — this class never imports `StreamAbortedError` itself. */
class AbortOnlyPort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(
    private readonly buildError: (partialBody: Uint8Array) => Error,
    private readonly partialBody: Uint8Array,
    private readonly onStarted: () => void,
  ) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    this.onStarted();
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          reject(this.buildError(this.partialBody));
        },
        { once: true },
      );
    });
  }
}

function startedGate(): { readonly started: Promise<void>; readonly onStarted: () => void } {
  let onStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  return { started, onStarted };
}

const parentTools: readonly ToolDefinition[] = [];

/** One real `OrchestrationChildRuntime` (`OrchestrationCore` +
 * `createChildRunner`) whose single child's stream never settles on its own
 * — it rejects with whatever `buildAbortError` constructs (a real
 * `StreamAbortedError`, imported dynamically by the caller) the moment the
 * leaf's own `AbortController` fires, replaying `partialText` first (never
 * an empty partial: the whole point is a non-zero estimated usage). */
function abortablePortRuntime(
  connectionDatabase: ReturnType<typeof openStateDatabase>["database"],
  ftsEnabled: boolean,
  partialText: string,
  buildAbortError: (partialBody: Uint8Array) => Error,
): {
  readonly runtime: OrchestrationChildRuntime;
  readonly started: Promise<void>;
} {
  const parentProfile = getProviderProfile("openai");
  if (parentProfile === null) throw new Error("openai profile missing");
  const sessions = new SessionRepository(connectionDatabase, () => 1000, ftsEnabled);
  sessions.createSession({ id: "parent-1", source: "gateway" });
  const { started, onStarted } = startedGate();
  const partialBody = encoder.encode(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: partialText }, finish_reason: null }],
    })}\n\n`,
  );
  const port = new AbortOnlyPort(buildAbortError, partialBody, onStarted);
  const client = new ChatCompletionsClient({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "k",
    transport: new ChatCompletionsTransport(),
    http: port,
  });
  const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
  const runChild = createChildRunner({
    sessions,
    parentSessionId: "parent-1",
    clientPool: pool,
    baseDispatch: () => Promise.resolve("should not be called"),
    parentToolDefinitions: parentTools,
    defaultModel: "fake-model-a",
    cwd: "/tmp",
    idSource: (() => {
      let seq = 0;
      return () => {
        seq += 1;
        return `child-abort-${String(seq)}`;
      };
    })(),
    clock: () => 1000,
    childMaxIterations: 50,
  });
  let subSeq = 0;
  const core = new OrchestrationCore({
    runChild,
    idSource: () => {
      subSeq += 1;
      return `leaf-${String(subSeq)}`;
    },
    maxSubsessions: 8,
    maxParallel: 4,
    buildSubagentPrompt: () => "SYS",
  });
  return { runtime: new OrchestrationChildRuntime(core), started };
}

function spec(): Record<string, unknown> {
  return { meta: { name: "abort-in-flight" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

function harness(partialText: string, buildAbortError: (partialBody: Uint8Array) => Error) {
  const root = mkdtempSync(join(tmpdir(), "lohra-abort-in-flight-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const { runtime, started } = abortablePortRuntime(
    connection.database,
    connection.ftsEnabled,
    partialText,
    buildAbortError,
  );
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
    started,
    close: (): void => {
      connection.close();
    },
  };
}

describe("workflow_cancel aborts an in-flight leaf's stream (issue #518)", () => {
  it("leaf.failed carries partial:true and a non-zero estimated usage, exactly one terminal, and workflow_status counts it in partial_leaves", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const buildAbortError = (partialBody: Uint8Array): Error =>
      new StreamAbortedError(
        { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
        { partialBody },
      );
    const { service, audit, started, close } = harness("x".repeat(29), buildAbortError);
    try {
      const startedRun = service.start(spec());
      if ("error" in startedRun) throw new Error(startedRun.error);
      await started;
      const before = Date.now();
      const cancelled = await service.cancel(startedRun.run_id);
      expect(Date.now() - before).toBeLessThan(4_000); // < SHUTDOWN_SETTLE_TIMEOUT_MS (5_000)
      expect("error" in cancelled).toBe(false);
      const page = audit.query({ runId: startedRun.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        status: "cancelled",
        error_kind: "cancelled",
        partial: true,
        usage_uncertain: true,
      });
      const usage = terminal[0]?.data.usage as { tokens_out: number } | undefined;
      expect(usage?.tokens_out).toBeGreaterThan(0);

      const final = (await service.status(startedRun.run_id, true)) as Record<string, unknown>;
      expect(final.partial_leaves).toBe(1);
    } finally {
      close();
    }
  });

  it("shutdown() tears the same in-flight leaf down: leaf.failed carries partial:true, exactly one terminal", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const buildAbortError = (partialBody: Uint8Array): Error =>
      new StreamAbortedError(
        { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
        { partialBody },
      );
    const { service, audit, started, close } = harness("y".repeat(29), buildAbortError);
    try {
      const startedRun = service.start(spec());
      if ("error" in startedRun) throw new Error(startedRun.error);
      await started;
      const before = Date.now();
      await service.shutdown();
      expect(Date.now() - before).toBeLessThan(5_000);
      const page = audit.query({ runId: startedRun.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        status: "cancelled",
        error_kind: "cancelled",
        partial: true,
      });
    } finally {
      close();
    }
  });
});

// Deterministic, isolated proof of the S3 audit-runtime.ts probe itself
// (`AuditedChildRuntime.cancel`) — drives it DIRECTLY, the same "one
// exception to never audit-runtime.ts's internals" convention
// `tests/workflow-audit-leaf.test.ts`'s own "collect wait:false returning
// running" test already takes, so the outcome never depends on which of two
// independent `collect()` calls happens to win a same-tick race (see the
// full-stack tests above for that end-to-end behavior instead). Nothing else
// ever calls `collect()` on this leaf, so `open` still holds it when
// `cancel()` runs — the probe is the ONLY thing that can close it.
describe("AuditedChildRuntime.cancel — real OrchestrationChildRuntime probe (issue #518)", () => {
  it("resolves once the leaf actually settles and writes the real partial usage, never the bare placeholder", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const buildAbortError = (partialBody: Uint8Array): Error =>
      new StreamAbortedError(
        { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
        { partialBody },
      );
    const root = mkdtempSync(join(tmpdir(), "lohra-abort-in-flight-direct-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const { runtime, started } = abortablePortRuntime(
        connection.database,
        connection.ftsEnabled,
        "z".repeat(29),
        buildAbortError,
      );
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const decorated = auditedRuntimeFor(
        runtime,
        trail,
        () => null,
        false,
        () => undefined,
      );
      const causalContext = {
        runId: "run-direct",
        segmentId: "seg-direct",
        nodePath: ["a"],
        cellId: "a",
        role: "agent" as const,
        attempt: 0,
        turn: 0,
      };
      const id = await decorated.spawn({ prompt: "one", causalContext });
      await started;
      const before = Date.now();
      await decorated.cancel(id);
      expect(Date.now() - before).toBeLessThan(2_000); // CANCEL_SETTLE_TIMEOUT_MS ceiling
      await trail.flush();
      const page = audit.query({ runId: "run-direct", limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        status: "cancelled",
        error_kind: "cancelled",
        // Issue #568: `cancel()` is the ONLY caller that ever names
        // `reason: "cancelled"` (`failedPayload(settled, "cancelled")`,
        // audit-runtime.ts) — pinned here, in the race between the sonda
        // (this probe) and the leaf's own settlement, so a regression that
        // drops the reason argument at that one call site (e.g.
        // `failedPayload(settled)`) is caught.
        reason: "cancelled",
        partial: true,
        usage_uncertain: true,
      });
      const usage = terminal[0]?.data.usage as { tokens_out: number } | undefined;
      expect(usage?.tokens_out).toBeGreaterThan(0);
    } finally {
      connection.close();
    }
  });
});

// Issue #568: `probeSettledAfterCancel` (audit-runtime.ts) — the sonda
// `AuditedChildRuntime.cancel` runs right after `inner.cancel` resolves —
// used to swallow any thrown error with a bare `catch {}`, and its
// `result.status === "running"` filter (the ceiling-elapsed-before-the-poll
// case) had no dedicated test with a REAL `OrchestrationChildRuntime`
// driving it. Both use a lean `OrchestrationCore` (no HTTP port needed —
// `probeSettledAfterCancel` only cares about `collect()`'s own outcome),
// same construction as `tests/workflow-orchestration-runtime-timeout.test.ts`.
describe("AuditedChildRuntime.cancel — probeSettledAfterCancel fail-closed (issue #568)", () => {
  function leanCore(
    runChild: import("../src/orchestration/core.js").ChildRunner,
  ): OrchestrationCore {
    let n = 0;
    return new OrchestrationCore({
      runChild,
      idSource: () => {
        n += 1;
        return `leaf-${String(n)}`;
      },
      maxSubsessions: 10,
      maxParallel: 4,
      buildSubagentPrompt: () => "SYS",
    });
  }

  function leanCausal(runId: string): CausalContext {
    return Object.freeze({
      runId,
      segmentId: "seg-1",
      nodePath: Object.freeze(["a"]),
      cellId: "a:0",
      role: "leaf" as const,
      attempt: 0,
      turn: 0,
    });
  }

  const doneResult = {
    status: "complete" as const,
    output: "done",
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

  it("a probe that throws is named via warn, fail-closed, never swallowed — cancel() still resolves with the bare placeholder", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-abort-in-flight-probe-error-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const core = leanCore(() => Promise.resolve(doneResult));
      const runtime = new OrchestrationChildRuntime(core);
      // The probe (`inner.collect`) throws exactly once — `inner.cancel`'s
      // OWN race (`this.core.collect`, a different, private call) is
      // unaffected, so the leaf still settles for real before this fires.
      vi.spyOn(runtime, "collect").mockRejectedValueOnce(new Error("probe boom"));
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const warnings: string[] = [];
      const decorated = auditedRuntimeFor(
        runtime,
        trail,
        () => null,
        false,
        (message) => {
          warnings.push(message);
        },
      );
      const id = await decorated.spawn({
        prompt: "one",
        causalContext: leanCausal("run-probe-error"),
      });
      await decorated.cancel(id);
      await trail.flush();
      const page = audit.query({ runId: "run-probe-error", limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({ status: "cancelled", error_kind: "cancelled" });
      expect(terminal[0]?.data).not.toHaveProperty("partial");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("probe boom");
      expect(warnings[0]).toContain(id);
    } finally {
      connection.close();
    }
  });

  it("a probe that finds the leaf still running (ceiling elapsed before the poll) is filtered out — never reported as a settled result", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-abort-in-flight-probe-running-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      // Never resolves: the leaf's own settle ceiling elapses before the
      // probe's own collect(wait:false) ever finds a real result.
      const core = leanCore(() => new Promise(() => undefined));
      const runtime = new OrchestrationChildRuntime(core);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const decorated = auditedRuntimeFor(
        runtime,
        trail,
        () => null,
        false,
        () => undefined,
      );
      const id = await decorated.spawn({
        prompt: "one",
        causalContext: leanCausal("run-probe-running"),
      });
      const before = Date.now();
      await decorated.cancel(id);
      expect(Date.now() - before).toBeLessThan(4_000); // CANCEL_SETTLE_TIMEOUT_MS ceiling
      await trail.flush();
      const page = audit.query({ runId: "run-probe-running", limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({ status: "cancelled", error_kind: "cancelled" });
      expect(terminal[0]?.data).not.toHaveProperty("partial");
      expect(terminal[0]?.data).not.toHaveProperty("usage");
    } finally {
      connection.close();
    }
  });
});
