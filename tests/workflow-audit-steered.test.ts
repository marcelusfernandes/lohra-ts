// Issue #423 (M10-S2, épico #421): `auditedChildRuntime.steer` (`audit-
// runtime.ts:280-281` on main e2f5966c) was a plain pass-through — a steer
// never left ANY trace in the audit ledger. This file pins the OBSERVABLE
// contract: `leaf.steered {source: "engine" | "operator", node_id, sub_id,
// attempt, message_chars}`, metadata-only (never the steer text itself).
// RED on main e2f5966c: `leaf.steered` is not in `SAFE_EVENT_TYPES`
// (`audit-model.ts`), so even a producer that emitted it would have the
// event rewritten to `audit.unavailable` at read time — and no producer
// emits it at all.
//
// Molded on `tests/workflow-audit-leaf.test.ts` (640 lines, not edited —
// the issue's `Files` list does not include it): same real sqlite-backed
// `WorkflowService` harness for the engine-driven schema-retry scenario
// (the ONLY caller `runtime.steer` has today, `engine.ts:304-308`). The
// operator-origin scenario has no caller yet (S3, a later issue) — driven
// directly against `auditedChildRuntime`, the decorator this issue's
// `Files` list actually touches, same posture `tests/workflow-audit-
// tool.test.ts` takes for `installLeafSandbox` seams no orchestration
// wiring exercises yet.
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
import { publicAuditEvent } from "../src/workflow/audit-model.js";
import {
  auditedChildRuntime,
  type AuditedChildRuntimeDeps,
} from "../src/workflow/audit-runtime.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  CausalContext,
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

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** One `spawn()` gets one queue of scripted `collect()` results, consumed in
 * order — the shape a schema retry needs: the first `collect()` fails
 * validation, `steer()` fixes it, the second `collect()` on the SAME id
 * succeeds. */
function scriptedRuntime(scripts: readonly (readonly ChildResult[])[]): ChildRuntime & {
  readonly spawned: ChildSpawnRequest[];
  readonly steered: readonly Readonly<{ id: string; prompt: string }>[];
} {
  const spawned: ChildSpawnRequest[] = [];
  const steered: Readonly<{ id: string; prompt: string }>[] = [];
  const byId = new Map<string, ChildResult[]>();
  return withMinimalLeafSandbox({
    spawned,
    steered,
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
    // #444: the leaf's FIRST collect() already returned "complete" before the
    // engine's schema check runs (engine.ts:274-296) — the entry is idle, not
    // inFlight, when the schema-retry `steer()` arrives. The REAL
    // `OrchestrationCore.steer` (core.ts:331-345) takes the idle/terminal
    // "resurrect" branch in that exact shape and returns `{queued: false}`
    // (no `refused`) — a genuine delivery, not a refusal. This scripted mock
    // returns the SAME shape a real core would, so this test exercises the
    // #444 predicate honestly instead of masking it with `{queued: true}`.
    //
    // Issue #450: `steer` is real `void` now, never called by the decorator
    // while `steerOutcome` (below) is present — the outcome it reads and
    // records `steered` against comes from `steerOutcome` alone.
    steer(): void {
      throw new Error("scriptedRuntime.steer must not be called while steerOutcome is present");
    },
    steerOutcome(id: string, prompt: string) {
      steered.push({ id, prompt });
      return { queued: false };
    },
    cancel: (): void => undefined,
  });
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

function schemaSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-steered-schema" },
    nodes: [{ id: "a", type: "agent", prompt: "one", schema: SCHEMA }],
  };
}

/** Real sqlite-backed durable store: `WorkflowRepository` + `LockRepository`
 * + `AuditRepository`/`AuditTrail` over ONE connection — the same
 * composition `WorkflowService` sees in production (`tests/workflow-audit-
 * leaf.test.ts`'s own `harness()`). */
function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-steered-"));
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

/** A bare `AuditRepository`/`AuditTrail` pair, no `WorkflowService` in
 * between — drives `auditedChildRuntime` directly, the shape an operator
 * steer (S3, no tool yet) will use once it holds the decorated runtime. */
function directHarness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-steered-direct-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const deps: AuditedChildRuntimeDeps = {
    trail,
    ownershipOf: () => null,
    durable: false,
    warn: () => undefined,
  };
  return {
    audit,
    trail,
    deps,
    close: (): void => {
      connection.close();
    },
  };
}

const CAUSAL: CausalContext = {
  runId: "run-operator-1",
  segmentId: "seg-1",
  nodePath: ["a"],
  cellId: "cell-1",
  role: "agent",
  attempt: 0,
  turn: 0,
};

describe("workflow audit — leaf.steered (#423)", () => {
  it("a schema retry's engine-driven steer produces leaf.steered{source:engine} with leaf.started's own sub_id, message_chars > 0, no prompt text", async () => {
    const runtime = scriptedRuntime([
      [
        { status: "complete", output: {}, usage: USAGE }, // fails the schema
        { status: "complete", output: { ok: true }, usage: USAGE }, // steer() fixed it
      ],
    ]);
    const { service, audit, close } = harness(runtime);
    try {
      const started = service.start(schemaSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      expect(runtime.steered).toHaveLength(1);
      const [correction] = runtime.steered;
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const steered = page.events.filter((event) => event.event_type === "leaf.steered");
      expect(steered).toHaveLength(1);
      const [event] = steered;
      expect(event?.identity.sub_id).toBe("leaf-1"); // same sub_id leaf.started carries
      expect(event?.data.source).toBe("engine");
      expect(typeof event?.data.message_chars).toBe("number");
      expect(event?.data.message_chars).toBeGreaterThan(0);
      expect(event?.data.message_chars).toBe(Array.from(correction?.prompt ?? "").length);
      // metadata-only: the correction text itself never reaches the event.
      expect(JSON.stringify(event?.data)).not.toContain(correction?.prompt);
      expect(Object.keys(event?.data ?? {})).toEqual(["source", "message_chars"]);
    } finally {
      close();
    }
  });

  it("an operator steer through the decorator produces leaf.steered{source:operator} for the SAME leaf spawn() opened", async () => {
    const { audit, trail, deps, close } = directHarness();
    try {
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({ status: "running", output: null }),
        // #444/#450: a busy leaf's REAL `core.steer` (core.ts:323-329)
        // pushes to the inbox and returns `{queued: true}` — the realistic
        // outcome for an operator steer at a still-running leaf, now
        // reported through the typed `steerOutcome` member, never `steer`'s
        // (real `void`) return.
        steer: (): void => undefined,
        steerOutcome: () => ({ queued: true }),
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.spawn({ prompt: "one", causalContext: CAUSAL });
      const prompt = "please pause and hand the task back to the caller";
      await runtime.steer("leaf-1", prompt, CAUSAL, "operator");
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      const steered = page.events.filter((event) => event.event_type === "leaf.steered");
      expect(steered).toHaveLength(1);
      const [event] = steered;
      expect(event?.identity.sub_id).toBe("leaf-1");
      expect(event?.identity.segment_id).toBe(CAUSAL.segmentId);
      expect(event?.identity.attempt).toBe(CAUSAL.attempt);
      expect(event?.data.source).toBe("operator");
      expect(event?.data.message_chars).toBe(Array.from(prompt).length);
    } finally {
      close();
    }
  });

  it("a steer on an id the decorator never opened still delegates, with no audit event", async () => {
    const { audit, trail, deps, close } = directHarness();
    try {
      let delegated: readonly [string, string] | null = null;
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({ status: "running", output: null }),
        steer: (id: string, prompt: string): void => {
          delegated = [id, prompt];
        },
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.steer("never-opened", "hello", CAUSAL, "operator");
      expect(delegated).toEqual(["never-opened", "hello"]);
      // #502 (non_blocking 1, PR #488): flush BEFORE the query — same
      // posture as #476's steer_cap/null cases below. Verified by hand: a
      // planted regression that records unconditionally inside
      // `deliverSteer`'s `innerSteerOutcome === undefined` branch (the path
      // this `inner` actually takes — it has no `steerOutcome`) fails THIS
      // assertion whether or not the flush is present, because `AuditTrail`
      // schedules its drain on a bare `Promise.resolve().then(...)`
      // microtask and the `await`s already unwound above happen to give it
      // enough turns. The flush is not what makes this oracle fail — it
      // makes the oracle's result independent of that drain-timing
      // coincidence, so a future change to how many turns unwind before
      // this line can't silently make the assertion pass vacuously again.
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);
    } finally {
      close();
    }
  });

  // #444: `leaf.steered` was recorded BEFORE `inner.steer` resolved — a
  // refusal, an unrecognised/terminal id, or an old `ChildRuntime` that
  // reports nothing at all (`void`, the port's own declared type) all wrote
  // the SAME event a genuinely-delivered steer would. The three cases below
  // pin the negative side of the fix: only `outcome !== null &&
  // outcome.refused === undefined` (covers `{queued:true}` and the
  // idle/terminal-resurrection `{queued:false}` above) still records.
  it("S1's steer_cap refusal ({queued:false, refused:'steer_cap'}) never reaches the ledger (#444)", async () => {
    const { audit, trail, deps, close } = directHarness();
    try {
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({ status: "running", output: null }),
        steer: (): void => undefined,
        steerOutcome: () => ({ queued: false, refused: "steer_cap" as const }),
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.spawn({ prompt: "one", causalContext: CAUSAL });
      await runtime.steer("leaf-1", "eleventh steer", CAUSAL, "operator");
      // #476: flush BEFORE the query — `AuditTrail.record` only buffers, so
      // without a flush this assertion would read zero rows even if A1
      // (`audit-runtime.ts:344`, `outcome.refused === undefined`) never ran
      // at all — an absence the buffer manufactures, not one the guard
      // proves (PR #474 veredito). Manual mutant check (test plan):
      // reverting :344 to `outcome !== null` makes THIS assertion fail,
      // exactly because the flush lets the wrongly-recorded row surface.
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("core.steer returning null (id unrecognised/terminal to the core) never reaches the ledger (#444)", async () => {
    const { audit, trail, deps, close } = directHarness();
    try {
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({ status: "running", output: null }),
        steer: (): void => undefined,
        steerOutcome: () => null,
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.spawn({ prompt: "one", causalContext: CAUSAL });
      await runtime.steer("leaf-1", "hello", CAUSAL, "operator");
      // #476: same reasoning as the `steer_cap` case above — flush before
      // asserting absence, or the buffer (not the guard) is what the
      // assertion actually tests.
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("a ChildRuntime that reports nothing (`undefined`, the declared void return) is treated as unproven, not recorded (#444)", async () => {
    // Decision (documented in #444's comment thread): NOT recording here is
    // deliberate, not an oversight. `undefined` is what every OTHER
    // `ChildRuntime.steer` implementation returns today (the port's own
    // declared type, `runtime.ts`) — the only production implementation
    // that reports an outcome at all is `OrchestrationChildRuntime`
    // (#424). Treating `undefined` as evidence of a queued steer would
    // invent a fact this decorator has no proof of; a caller with a real
    // outcome to report already returns an object (`{queued: ...}`), never
    // relies on this fallback.
    const { audit, trail, deps, close } = directHarness();
    try {
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({ status: "running", output: null }),
        steer: (): void => undefined,
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.spawn({ prompt: "one", causalContext: CAUSAL });
      await runtime.steer("leaf-1", "hello", CAUSAL, "operator");
      // #502 (non_blocking 1, PR #488): same flush-before-query posture as
      // the two cases above — makes the oracle independent of
      // `AuditTrail`'s drain-microtask timing rather than relying on it
      // (see that comment for the mutation this was verified against).
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      expect(page.events.filter((event) => event.event_type === "leaf.steered")).toHaveLength(0);
    } finally {
      close();
    }
  });

  // Issue #520 (M16-S5, épico #490, ADR 0005): a steer that also interrupted
  // a call genuinely in flight (D2) marks `leaf.steered.data.interrupted`,
  // and the leaf's own settled result — carrying `partial: true` once the
  // turn absorbed at least one interrupted call and still completed (D3) —
  // reaches `leaf.completed.data.partial` the same way S2 already wired for
  // a failed/cancelled leaf. RED on main 167c2669: `SteerOutcome` has no
  // `interrupted` key, and `BOOLEAN_FIELDS` (audit-model.ts) has no
  // `interrupted` entry — the payload is dropped at read time even if a
  // producer wrote it.
  it("an interrupted operator steer marks leaf.steered.data.interrupted, and a partial-but-complete leaf marks leaf.completed.data.partial (#520)", async () => {
    const { audit, trail, deps, close } = directHarness();
    try {
      const inner: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({
          status: "complete",
          output: "done",
          usage: USAGE,
          partial: true,
        }),
        steer: (): void => undefined,
        steerOutcome: () => ({ queued: true, interrupted: true }),
        cancel: (): void => undefined,
      });
      const runtime = auditedChildRuntime(inner, deps);
      await runtime.spawn({ prompt: "one", causalContext: CAUSAL });
      const prompt = "please stop the current call and read this instead";
      await runtime.steer("leaf-1", prompt, CAUSAL, "operator");
      await runtime.collect("leaf-1", { wait: true, timeoutSeconds: 5 });
      await trail.flush();
      const page = audit.query({ runId: CAUSAL.runId, limit: 50 });
      const steered = page.events.find((event) => event.event_type === "leaf.steered");
      expect(steered?.data.interrupted).toBe(true);
      const completed = page.events.find((event) => event.event_type === "leaf.completed");
      expect(completed?.data.partial).toBe(true);
    } finally {
      close();
    }
  });
});

describe("audit-model allow-list — leaf.steered (#423)", () => {
  it("accepts leaf.steered as a real event_type, not audit.unavailable", () => {
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "leaf.steered",
        segment_id: "seg-1",
        node_id: "a",
        sub_id: "leaf-1",
        attempt: 0,
        payload: { source: "engine", message_chars: 12 },
      },
      1,
    );
    expect(event.event_type).toBe("leaf.steered");
    expect(event.data.source).toBe("engine");
    expect(event.data.message_chars).toBe(12);
  });

  it("accepts operator as a source value", () => {
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "leaf.steered",
        payload: { source: "operator", message_chars: 3 },
      },
      1,
    );
    expect(event.data.source).toBe("operator");
  });

  it("redacts a source value outside {engine, operator, ...the existing vocabulary} instead of leaking it", () => {
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "leaf.steered",
        payload: { source: "some-private-caller-id", message_chars: 3 },
      },
      1,
    );
    expect(event.data.source).toEqual({ state: "excluded_by_policy", characters: 22 });
  });
});
