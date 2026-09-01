import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { classifyProviderError, RateLimitError } from "../src/transports/errors.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { TaintTracker } from "../src/workflow/sandbox.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";
import type { Usage } from "../src/pricing/types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function runtimeStub(output: unknown = { answer: "ok" }): ChildRuntime & { calls: number; releaseFirst(): void } {
  const leaves = new Map<string, ChildResult>();
  let seq = 0;
  let release: (() => void) | null = null;
  let gate: Promise<void> = Promise.resolve();
  let armed = false;
  const usage1: Usage = {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const runtime = {
    calls: 0,
    releaseFirst(): void {
      armed = true;
      if (release === null) {
        gate = new Promise<void>((res) => {
          release = res;
        });
      }
    },
    spawn() {
      seq += 1;
      runtime.calls += 1;
      const id = `leaf-${String(seq)}`;
      if (seq === 1 && armed) {
        // The first leaf blocks until released: deterministic steal window.
        void gate.then(() => {
          leaves.set(id, { status: "complete", output, usage: usage1 });
        });
      } else {
        leaves.set(id, { status: "complete", output, usage: usage1 });
      }
      return id;
    },
    collect(id: string): ChildResult {
      return leaves.get(id) ?? { status: "failed", output: null };
    },
    steer(): void {
      return undefined;
    },
    cancel(): void {
      return undefined;
    },
  };
  return runtime;
}

function spec(): Record<string, unknown> {
  return {
    meta: { name: "durable" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

function connection_expireLease(runId: string): void {
  // Test seam: force the stretch's lease to look expired without advancing the
  // wall clock (the repository uses a fixed now=1000 everywhere).
  const root = roots.at(-1);
  if (root === undefined) throw new Error("no harness root");
  const connection = openStateDatabase(join(root, "state.db"));
  connection.database
    .prepare("UPDATE workflow_run_locks SET expires_at = 500 WHERE run_id = ?")
    .run(runId);
  connection.close();
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const serviceRuntime = runtimeStub();
  const service = new WorkflowService({
    runtime: serviceRuntime,
    store: {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    },
    cacheFactory: (runId) =>
      new SqliteWorkflowCache(connection.database, runId, () => ({
        fence: ownership.fence,
        holder: ownership.holder,
        now: ownership.now,
      })),
  });
  return { service, repository, locks, ownership, runtime: serviceRuntime, close: () => { connection.close(); } };
}

describe("workflow service durability", () => {
  it("launches under a lease: run state line + spend row written under ownership", async () => {
    const { service, repository, close } = harness();
    const started = service.start(spec(), {});
    if ("error" in started) throw new Error(started.error);
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(final.status).toBe("complete");
    const line = repository.getRunState(started.run_id);
    expect(line).not.toBeNull();
    expect((line as Record<string, unknown>).status).toBe("complete");
    // the run-level ledger landed BEFORE the lease was released, with the
    // terminal stretch's tokens (3+2) — a post-release persist would be refused
    const spendRow = repository.getRunSpend(started.run_id);
    expect(spendRow).not.toBeNull();
    expect(Number(spendRow?.tokens_in)).toBe(3);
    expect(Number(spendRow?.tokens_out)).toBe(2);
    close();
  });

  it("rejects a second acquire on a live run with the exact busy error", () => {
    const { service, locks, close } = harness();
    // foreign process holds the lease
    locks.acquireRunLease("busy-run", "other", 1000, 900);
    const out = service.start(spec(), {}, { resumeRunId: "busy-run" });
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("is being resumed by another process");
    expect((out as { error: string }).error).toContain("expires in ~");
    close();
  });

  it("refuses raise-only budget on resume with the didactic message", () => {
    const { service, repository, locks, close } = harness();
    repository.putRunState("spent-run", {
      name: "s", owner: null, status: "paused", pauseReason: "token_budget_exhausted",
      pausePayloadJson: null, specJson: JSON.stringify(spec()), argsJson: "{}",
      tokenBudget: 100, tainted: false, progressJson: null, auditSegmentId: null,
      updatedAt: 1000, fence: null, holder: null, now: 1000,
    });
    // Seed the ledger via the owned path of a real lease so the refusal math
    // has a persisted floor (the oracle's row ledger).
    const seedFence = locks.acquireRunLease("spent-run", "seeder", 1000, 900);
    if (seedFence === null) throw new Error("seed lease");
    repository.putRunSpend("spent-run", 100, 60, 60, 0, 0, 0, {
      fence: seedFence,
      holder: "seeder",
      now: 1000,
    });
    locks.releaseRunLease("spent-run", "seeder");
    const out = service.start(spec(), {}, { resumeRunId: "spent-run", tokenBudget: 100 });
    expect((out as { error: string }).error).toContain("has already spent 120 tokens");
    expect((out as { error: string }).error).toContain("resume it with a bigger one");
    close();
  });

  it("pause reason is the oracle-aligned token_budget_exhausted", async () => {
    const { service, repository, close } = harness();
    const started = service.start(
      {
        meta: { name: "budget" },
        nodes: [
          { id: "a", type: "agent", prompt: "x" },
          { id: "b", type: "agent", prompt: "y" },
        ],
      },
      {},
      { tokenBudget: 1 },
    );
    if ("error" in started) throw new Error(started.error);
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    // leaf spends 3 tokens > budget 1 → paused
    expect(final.status).toBe("paused");
    expect(final.pause_reason ?? (final as { reason?: string }).reason).toBe("token_budget_exhausted");
    const line = repository.getRunState(started.run_id);
    expect((line as Record<string, unknown>).pause_reason).toBe("token_budget_exhausted");
    close();
  });

  it("checkpoint pause persists the payload and resume in-process continues", async () => {
    const { service, repository, close } = harness();
    const started = service.start({
      meta: { name: "cp" },
      nodes: [{ id: "cp1", type: "checkpoint", prompt: "answer me" }],
    });
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    expect(line.pause_reason).toBe("checkpoint");
    const payload = JSON.parse(String(line.pause_payload_json)) as { checkpoint: Record<string, unknown> };
    expect(payload.checkpoint).toMatchObject({ node_id: "cp1" });
    close();
  });

  it("seeds spend only AFTER acquiring the lease (seed read refused while busy)", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let seedReads = 0;
      const target = repository;
      const proxy = new Proxy(repository, {
        get(t: WorkflowRepository, prop: string | symbol, receiver: unknown): unknown {
          if (prop === "getRunSpend") {
            return (...args: Parameters<WorkflowRepository["getRunSpend"]>) => {
              seedReads += 1;
              return target.getRunSpend(...args);
            };
          }
          return Reflect.get(t, prop, receiver);
        },
      });
      const service = new WorkflowService({
        runtime: runtimeStub(),
        store: { repository: proxy, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      // foreign lease live: the start must fail busy WITHOUT any seed read
      locks.acquireRunLease("seed-order-run", "foreign", 1000, 900);
      repository.putRunState("seed-order-run", {
        name: "s", owner: "foreign", status: "running", pauseReason: null,
        pausePayloadJson: null, specJson: JSON.stringify(spec()), argsJson: "{}",
        tokenBudget: null, tainted: false, progressJson: null, auditSegmentId: null,
        updatedAt: 1000, fence: 1, holder: "foreign", now: 1000,
      });
      const out = service.start(spec(), {}, { resumeRunId: "seed-order-run" });
      expect(out).toHaveProperty("error");
      expect((out as { error: string }).error).toContain("is being resumed by another process");
      expect(seedReads).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("token budget pause never arms auto-resume; quota pause arms it with retry_after", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const timers: { delay: number; fire(): void; cancelled: boolean }[] = [];
      const timerFactory = (delay: number, fire: () => void) => {
        const timer = { delay, fire, cancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      };
      const successRuntime = {
        spawned: 0,
        spawn(): string { this.spawned += 1; return `leaf-${String(this.spawned)}`; },
        collect(): { status: "complete"; output: unknown; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } } {
          return { status: "complete", output: { answer: "ok" }, usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
        },
        steer(): void {},
        cancel(): void {},
      };
      const quotaRuntime = {
        spawned: 0,
        spawn(): string { this.spawned += 1; return `leaf-${String(this.spawned)}`; },
        collect(): { status: "failed"; output: null; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }; errorKind: string; retryAfter: number } {
          return { status: "failed", output: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, errorKind: "quota_exhausted", retryAfter: 120 };
        },
        steer(): void {},
        cancel(): void {},
      };
      const budgetService = new WorkflowService({
        runtime: successRuntime,
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
        timerFactory,
      });
      // token budget pause: budget 1, two nodes spend 5 → second spawn gated, NO scheduler arm
      const budgeted = budgetService.start(
        { meta: { name: "budget" }, nodes: [{ id: "a", type: "agent", prompt: "x" }, { id: "b", type: "agent", prompt: "y" }] },
        {},
        { tokenBudget: 1 },
      );
      if ("error" in budgeted) throw new Error(budgeted.error);
      await budgetService.status(budgeted.run_id, true);
      expect(timers.length).toBe(1); // heartbeat only
      const budgetLine = repository.getRunState(budgeted.run_id) as Record<string, unknown>;
      expect(budgetLine.pause_reason).toBe("token_budget_exhausted");
      const budgetPayload = JSON.parse(String(budgetLine.pause_payload_json)) as { resume_at: number | null };
      expect(budgetPayload.resume_at).toBeNull();

      const quotaService = new WorkflowService({
        runtime: quotaRuntime,
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
        timerFactory,
      });
      // quota pause: arms one bounded retry (retry_after 120 → delay 120), line carries resume_at
      const quota = quotaService.start(
        { meta: { name: "quota" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] },
        {},
      );
      if ("error" in quota) throw new Error(quota.error);
      const armedBefore = timers.length;
      const quotaFinal = (await quotaService.status(quota.run_id, true)) as Record<string, unknown>;
      expect(quotaFinal.status).toBe("paused");
      expect((quotaFinal as { pause_reason?: string }).pause_reason ?? (quotaFinal as { reason?: string }).reason).toBe("quota_exhausted");
      // exactly ONE new timer over the quota stretch: the armed retry
      expect(timers.length).toBe(armedBefore + 1);
      expect(timers[timers.length - 1]?.delay).toBe(120);
      const quotaLine = repository.getRunState(quota.run_id) as Record<string, unknown>;
      expect(quotaLine.pause_reason).toBe("quota_exhausted");
      const quotaPayload = JSON.parse(String(quotaLine.pause_payload_json)) as { resume_at: number | null; attempts: number };
      expect(quotaPayload.attempts).toBe(1);
      expect(quotaPayload.resume_at).not.toBeNull();
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("durable launch defaults to the fenced SQLite node cache (replay without respawn)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const runtime = {
        spawned: 0,
        spawn(): string { this.spawned += 1; return `leaf-${String(this.spawned)}`; },
        collect(): { status: "complete"; output: unknown; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } } {
          return {
            status: "complete",
            output: { answer: "ok" },
            usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          };
        },
        steer(): void {},
        cancel(): void {},
      };
      const service = new WorkflowService({
        runtime,
        store: {
          repository, locks, holder: "test", ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec(), {});
      if ("error" in started) throw new Error(started.error);
      const first = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(first.status).toBe("complete");
      expect(runtime.spawned).toBe(1);
      // a fenced SQLite cell + cost landed
      const cells = connection.database
        .prepare("SELECT count(*) AS n FROM workflow_node_cache WHERE run_id = ?")
        .get(started.run_id) as { n: bigint };
      expect(Number(cells.n)).toBe(1);
      // resume replays from the SQLite cache: zero respawns, complete again
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      const second = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(second.status).toBe("complete");
      expect(runtime.spawned).toBe(1);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancel busy is decided by the write's own statement (write attempted and refused)", () => {
    const { repository, locks, close } = harness();
    // foreign lease live
    locks.acquireRunLease("cancel-busy", "foreign", 1000, 900);
    repository.putRunState("cancel-busy", {
      name: "c", owner: "foreign", status: "running", pauseReason: null,
      pausePayloadJson: null, specJson: "{}", argsJson: "{}", tokenBudget: null,
      tainted: false, progressJson: null, auditSegmentId: null,
      updatedAt: 1000, fence: 1, holder: "foreign", now: 1000,
    });
    let writeAttempts = 0;
    const original = repository.putRunState.bind(repository);
    const spy = new Proxy(repository, {
      get(target, prop) {
        if (prop === "putRunState") {
          return (...args: Parameters<WorkflowRepository["putRunState"]>) => {
            writeAttempts += 1;
            return original(...args);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const cancelling = new WorkflowService({
      runtime: runtimeStub(),
      store: {
        repository: spy, locks, holder: "canceller", ttl: 900,
        ownershipOf: () => ({ fence: 9, holder: "canceller", now: 1000 }),
        database: (undefined as unknown as import("better-sqlite3").Database),
      },
    });
    const out = cancelling.cancel("cancel-busy");
    expect(out).toMatchObject({ error: "busy", run_id: "cancel-busy" });
    expect(writeAttempts).toBe(1);
    close();
  });

  it("runAndWait resolves bounded with the errata envelope when the terminal write loses ownership", async () => {
    // A live lease cannot be stolen — the loser's acquire returns null (busy).
    // The ownership-loss window is post-TTL-expiry: the stretch's lease expires
    // while the leaf is in flight, another process acquires, and the stretch's
    // terminal write then presents an expired lease and must be refused.
    const { service, locks, runtime, close } = harness();
    runtime.releaseFirst(); // arm the gate BEFORE start: leaf 1 blocks in flight
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    // Expire the stretch's lease and let a new owner in while the leaf flies.
    connection_expireLease(started.run_id);
    const thiefFence = locks.acquireRunLease(started.run_id, "thief", 1000, 900);
    if (thiefFence === null) throw new Error("thief should have won after expiry");
    // The thief's acquire advanced the fence and moved the holder, so the
    // stretch's terminal write presents a token that is no longer current.
    // BOUNDED: the waiter must settle on its own. Racing it against a short
    // timer means a waiter left hanging fails here, not on a suite timeout.
    let bell: ReturnType<typeof setTimeout> | undefined;
    const result = (await Promise.race([
      service.status(started.run_id, true),
      new Promise<Record<string, unknown>>((resolveRace) => {
        bell = setTimeout(() => { resolveRace({ error: "WAITER HUNG" }); }, 1_000);
      }),
    ])) as Record<string, unknown>;
    clearTimeout(bell);
    expect(result).toMatchObject({
      error: "workflow ownership lost",
      cause: "STALE_FENCE_WRITE",
      run_id: started.run_id,
    });
    close();
  });

  it("the terminal write reads the clock AT WRITE TIME: a lease that expired mid-run is refused", async () => {
    // R1's independent probe: a lease [1000, 1900) must not accept a terminal
    // write once the clock has passed 1900. No thief and no DB surgery here —
    // only time moving, so the sole thing under test is WHEN `now` is read.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const runtime: ChildRuntime = {
        spawn(): string {
          // the leaf outlives the lease: TTL 900 from 1000, and it is now 1901
          ownership.now = 1000 + 901;
          return "leaf-1";
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        // no live timers: a heartbeat renewal would be a second variable
        timerFactory: () => ({ cancel: () => undefined }),
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      expect(locks.runLeaseExpiry(started.run_id, 1000)).toBe(1900);
      const result = (await service.status(started.run_id, true)) as Record<string, unknown>;
      // presented at now=1901 against expires_at=1900: refused, fail-closed
      expect(result).toMatchObject({ error: "workflow ownership lost", cause: "STALE_FENCE_WRITE" });
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(line.status).toBe("running");
      // the LAUNCH ledger write (at now=1000, under a live lease) stands; the
      // terminal one, carrying the leaf's 3+2, was refused
      expect(Number(repository.getRunSpend(started.run_id)?.tokens_in)).toBe(0);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a refused terminal write publishes NO done event and no terminal line", async () => {
    // Same ownership-loss window, but watching the notify channel: fail-closed
    // means nothing terminal is published anywhere, not just in the ledger.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const events: { kind: string; state?: string }[] = [];
      const runtime = runtimeStub();
      runtime.releaseFirst();
      const service = new WorkflowService({
        runtime,
        onEvent: (event) => { events.push({ kind: event.kind, ...(event.state === undefined ? {} : { state: event.state }) }); },
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      connection.database
        .prepare("UPDATE workflow_run_locks SET expires_at = 500 WHERE run_id = ?")
        .run(started.run_id);
      expect(locks.acquireRunLease(started.run_id, "thief", 1000, 900)).not.toBeNull();
      // the thief advanced the fence and took the holder slot
      const result = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(result.error).toBe("workflow ownership lost");
      // the line the thief owns was never overwritten with a terminal status
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(line.status).toBe("running");
      // and no node event ever announced a completed terminal state
      expect(events.some((event) => event.state === "complete")).toBe(false);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicting a run from the bounded fence memory refuses its writes fail-closed", async () => {
    // FENCE_MEMORY shrunk to 1: launching a second run forgets the first run's
    // token, and the first stretch has no honest fence left to present.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      // Deterministic eviction: run-1's own leaf launches run-2, so run-1 is
      // forgotten from the 1-entry memory BEFORE its terminal write.
      const running: { service: WorkflowService | null } = { service: null };
      let evicted = false;
      let leafSeq = 0;
      const runtime: ChildRuntime = {
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
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: (() => { let n = 0; return () => { n += 1; return `run-${String(n)}`; }; })(),
        fenceMemory: 1,
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      running.service = service;
      const first = service.start(spec());
      if ("error" in first) throw new Error(first.error);
      // run-1 was evicted: its terminal write is refused without ever
      // presenting a guessed token, and its waiter resolves with the envelope
      const result = (await service.status(first.run_id, true)) as Record<string, unknown>;
      expect(evicted).toBe(true);
      expect(result.error).toBe("workflow ownership lost");
      expect((repository.getRunState(first.run_id) as Record<string, unknown>).status).toBe("running");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a provider quota error classified by the shared taxonomy pauses the run and arms one retry", async () => {
    // The pause reason is NOT invented here: the leaf's errorKind comes from
    // src/transports/errors.ts, and the engine/service consume that value.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const kind = classifyProviderError(new RateLimitError("429 slow down"));
      expect(kind).toBe("quota_exhausted");
      const timers: { delay: number }[] = [];
      const runtime = {
        spawn: () => "leaf-1",
        collect: (): ChildResult => ({
          status: "failed",
          output: null,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          errorKind: kind,
          retryAfter: 300,
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        timerFactory: (delay) => { timers.push({ delay }); return { cancel: () => undefined }; },
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("paused");
      expect(final.pause_reason).toBe("quota_exhausted");
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(line.pause_reason).toBe("quota_exhausted");
      expect(timers.map((timer) => timer.delay)).toContain(300);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cold start re-arms the quota-paused lines a dead process left behind", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "cold", now: 1000 };
      const fence = locks.acquireRunLease("orphan", "dead", 1000, 900);
      if (fence === null) throw new Error("expected lease");
      const paused = (runId: string, reason: string): void => {
        repository.putRunState(runId, {
          name: "n", owner: "dead", status: "paused", pauseReason: reason,
          pausePayloadJson: JSON.stringify({ checkpoint: null, resume_at: null, attempts: 1, prior_faults: [], prior_degraded: false }),
          specJson: JSON.stringify(spec()), argsJson: "{}", tokenBudget: null,
          tainted: false, progressJson: null, auditSegmentId: null,
          updatedAt: 1000, fence, holder: "dead", now: 1000,
        });
      };
      paused("orphan", "quota_exhausted");
      locks.releaseRunLease("orphan", "dead");
      const starved = locks.acquireRunLease("starved", "dead", 1000, 900);
      if (starved === null) throw new Error("expected lease");
      repository.putRunState("starved", {
        name: "n", owner: "dead", status: "paused", pauseReason: "token_budget_exhausted",
        pausePayloadJson: JSON.stringify({ checkpoint: null, resume_at: null, attempts: 1, prior_faults: [], prior_degraded: false }),
        specJson: JSON.stringify(spec()), argsJson: "{}", tokenBudget: 1,
        tainted: false, progressJson: null, auditSegmentId: null,
        updatedAt: 1000, fence: starved, holder: "dead", now: 1000,
      });
      locks.releaseRunLease("starved", "dead");
      const timers: { delay: number }[] = [];
      const cold = new WorkflowService({
        runtime: runtimeStub(),
        timerFactory: (delay) => { timers.push({ delay }); return { cancel: () => undefined }; },
        store: { repository, locks, holder: "cold", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      expect(cold).toBeInstanceOf(WorkflowService);
      // exactly ONE re-arm at construction: the quota line. The token-budget
      // line is never re-armed — waiting does not refill a budget.
      expect(timers.length).toBe(1);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workflow service — leaf capability sandbox", () => {
  function policyFile(root: string, body: Record<string, unknown>): string {
    const path = join(root, "workflow_policy.json");
    writeFileSync(path, JSON.stringify(body), "utf8");
    return path;
  }

  it("the leaf dispatch of a launched run carries the OPERATOR policy, not the spec", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const readOnlyRoot = join(root, "reference");
    mkdirSync(readOnlyRoot, { recursive: true });
    const path = policyFile(root, {
      fs_allow: [{ path: readOnlyRoot, mode: "ro" }],
      egress_allow: ["docs.example.com"],
    });
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const tracker = new TaintTracker();
      const seen: string[] = [];
      const results: { step: string; out: string }[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let runId = "";
      // A leaf asks for its dispatch WHILE the stretch is live — that is when
      // real leaves run, and it is the only place the acquisition's policy,
      // working root and taint are the live ones.
      const runtime: ChildRuntime = {
        spawn(): string {
          const owner = running.service;
          if (owner !== null && results.length === 0) {
            const dispatch = owner.leafToolDispatch(runId, (name) => { seen.push(name); return "OK"; });
            const workingRoot = owner.workingRootFor(runId);
            mkdirSync(workingRoot, { recursive: true });
            const step = (label: string, out: string): void => { results.push({ step: label, out }); };
            step("inside-working-root", dispatch("write_file", { path: join(workingRoot, "note.txt") }));
            step("outside-every-root", dispatch("read_file", { path: join(root, "elsewhere.txt") }));
            step("ro-root-read", dispatch("read_file", { path: join(readOnlyRoot, "a.txt") }));
            step("ro-root-write", dispatch("write_file", { path: join(readOnlyRoot, "a.txt") }));
            step("egress-denied", dispatch("web_fetch", { url: "https://evil.example.com/x" }));
            step("taint-before", String(tracker.tainted));
            step("egress-allowed", dispatch("web_fetch", { url: "https://DOCS.example.com/x" }));
            step("taint-after", String(tracker.tainted));
            step("tainted-fs", dispatch("read_file", { path: join(readOnlyRoot, "a.txt") }));
            step("tainted-egress", dispatch("web_fetch", { url: "https://docs.example.com/x" }));
          }
          return "leaf-1";
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        policyPath: path,
        taintTracker: tracker,
        homeRoot: root,
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      running.service = service;
      // a spec that TRIES to widen its own capability changes nothing
      const started = service.start({
        meta: { name: "durable", fs_allow: ["/"], egress_allow: ["*"] },
        nodes: [{ id: "a", type: "agent", prompt: "do it" }],
      });
      if ("error" in started) throw new Error(started.error);
      runId = started.run_id;
      await service.status(started.run_id, true);
      expect(results).toEqual([
        // inside the run's own scratch root: allowed
        { step: "inside-working-root", out: "OK" },
        // outside every root: exact denial, and the SPEC's fs_allow ["/"] did
        // not widen it — the policy is the operator file, only
        { step: "outside-every-root", out: "ERROR: path is outside the workflow working scope (sandbox denied)" },
        // under a read-only operator root: read ok, write refused with its own text
        { step: "ro-root-read", out: "OK" },
        { step: "ro-root-write", out: "ERROR: path is under a read-only workflow root (sandbox denied the write)" },
        // egress: exact host match only; the spec's "*" widened nothing
        { step: "egress-denied", out: "ERROR: host is not in the workflow egress allowlist (sandbox denied)" },
        { step: "taint-before", out: "false" },
        // the allowed fetch runs AND taints the session
        { step: "egress-allowed", out: "OK" },
        { step: "taint-after", out: "true" },
        // taint is live inside the SAME stretch: fs and egress both close
        { step: "tainted-fs", out: "ERROR: tainted run: filesystem access is disabled for leaves" },
        { step: "tainted-egress", out: "ERROR: tainted run: web egress is disabled for leaves" },
      ]);
      // a denied call never reached the base dispatch
      expect(seen).toEqual(["write_file", "read_file", "web_fetch"]);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("taint survives the resume: the durable line carries it into the next stretch", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const path = policyFile(root, { fs_allow: [root], egress_allow: [] });
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const tracker = new TaintTracker();
      const service = new WorkflowService({
        runtime: runtimeStub(),
        policyPath: path,
        taintTracker: tracker,
        homeRoot: root,
        store: { repository, locks, holder: "test", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      expect(Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted)).toBe(0);
      // a leaf taints the session, then the run is resumed by a FRESH service
      service.leafToolDispatch(started.run_id, () => "OK")("web_search", { query: "x" });
      expect(tracker.tainted).toBe(true);
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      expect(Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted)).toBe(1);
      // a brand-new process (clean tracker) still gets a tainted stretch
      const cold = new WorkflowService({
        runtime: runtimeStub(),
        policyPath: path,
        taintTracker: new TaintTracker(),
        homeRoot: root,
        store: { repository, locks, holder: "cold", ttl: 900, ownershipOf: () => ownership, database: connection.database },
      });
      const again = cold.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in again) throw new Error(again.error);
      await cold.status(started.run_id, true);
      expect(cold.leafToolDispatch(started.run_id, () => "OK")("read_file", { path: join(root, "a.txt") })).toBe(
        "ERROR: tainted run: filesystem access is disabled for leaves",
      );
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
