import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  WorkflowRepository,
  LockRepository,
  type StateWarning,
} from "../src/state/index.js";
import { classifyProviderError, RateLimitError } from "../src/transports/errors.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { TaintTracker } from "../src/workflow/sandbox.js";
import { WorkflowService } from "../src/workflow/service.js";
import {
  EVIDENCE_NORMALIZATIONS,
  normalizeEvidence,
} from "../scripts/parity/workflow-durability/workers/normalize-evidence.mjs";
import type {
  ChildResult,
  ChildRuntime,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";
import type { Usage } from "../src/pricing/types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function runtimeStub(
  output: unknown = { answer: "ok" },
): ChildRuntime & { calls: number; releaseFirst(): void; release(): void } & LeafSandboxed {
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
    /** Let the blocked first leaf finish. */
    release(): void {
      release?.();
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
  return withLeafSandbox(runtime);
}

/**
 * A reference `ChildRuntime` that really sandboxes its leaves. It keeps ONE
 * installation per acquisition, keyed by that acquisition's fence, and every
 * leaf tool call runs through the wrapper the service installed for it — so
 * these tests exercise enforcement, not a no-op that merely accepts the call.
 */
interface LeafSandboxed {
  /** Run a leaf tool through the wrapper installed for `fence`. */
  leafTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string;
  retiredTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string;
  installedFences(): readonly number[];
  disposedFences(): readonly number[];
  baseCalls(): readonly string[];
}

function withLeafSandbox<T extends ChildRuntime>(runtime: T): T & LeafSandboxed {
  const installed = new Map<number, LeafToolDispatch>();
  const retired = new Map<number, LeafToolDispatch>();
  const disposed: number[] = [];
  const seen: string[] = [];
  const base: LeafToolDispatch = (name) => {
    seen.push(name);
    return `allowed:${name}`;
  };
  return Object.assign(runtime, {
    installLeafSandbox(installation: LeafSandboxInstallation): LeafSandboxHandle {
      installed.set(installation.fence, installation.wrap(base));
      return {
        dispose: () => {
          // ONLY this acquisition's installation
          const dispatch = installed.get(installation.fence);
          if (dispatch !== undefined) retired.set(installation.fence, dispatch);
          installed.delete(installation.fence);
          disposed.push(installation.fence);
        },
      };
    },
    leafTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string {
      const dispatch = installed.get(fence);
      if (dispatch === undefined)
        throw new Error(`no leaf sandbox installed for fence ${String(fence)}`);
      return dispatch(name, args);
    },
    /** A wrapper from an acquisition that has already ended. */
    retiredTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string {
      const dispatch = retired.get(fence);
      if (dispatch === undefined) throw new Error(`no retired sandbox for fence ${String(fence)}`);
      return dispatch(name, args);
    },
    installedFences: (): readonly number[] => [...installed.keys()].sort((a, b) => a - b),
    disposedFences: (): readonly number[] => [...disposed],
    baseCalls: (): readonly string[] => [...seen],
  });
}

/** A runtime whose single leaf genuinely stays in flight until released. */
function gatedRuntime() {
  let open!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return withLeafSandbox({
    spawn: (): string => "leaf-1",
    collect: async (): Promise<ChildResult> => {
      await gate;
      return {
        status: "complete",
        output: { answer: "ok" },
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      };
    },
    steer: (): void => undefined,
    cancel: (): void => undefined,
    release: (): void => {
      open();
    },
  });
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
  return {
    service,
    repository,
    locks,
    ownership,
    runtime: serviceRuntime,
    close: () => {
      connection.close();
    },
  };
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
      name: "s",
      owner: null,
      status: "paused",
      pauseReason: "token_budget_exhausted",
      pausePayloadJson: null,
      specJson: JSON.stringify(spec()),
      argsJson: "{}",
      tokenBudget: 100,
      tainted: false,
      progressJson: null,
      auditSegmentId: null,
      updatedAt: 1000,
      fence: null,
      holder: null,
      now: 1000,
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
    expect(final.pause_reason ?? (final as { reason?: string }).reason).toBe(
      "token_budget_exhausted",
    );
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
    const payload = JSON.parse(String(line.pause_payload_json)) as {
      checkpoint: Record<string, unknown>;
    };
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
        store: {
          repository: proxy,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      // foreign lease live: the start must fail busy WITHOUT any seed read
      locks.acquireRunLease("seed-order-run", "foreign", 1000, 900);
      repository.putRunState("seed-order-run", {
        name: "s",
        owner: "foreign",
        status: "running",
        pauseReason: null,
        pausePayloadJson: null,
        specJson: JSON.stringify(spec()),
        argsJson: "{}",
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence: 1,
        holder: "foreign",
        now: 1000,
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
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      };
      const successRuntime = withLeafSandbox({
        spawned: 0,
        spawn(): string {
          this.spawned += 1;
          return `leaf-${String(this.spawned)}`;
        },
        collect(): {
          status: "complete";
          output: unknown;
          usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            reasoningTokens: number;
          };
        } {
          return {
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          };
        },
        steer(): void {},
        cancel(): void {},
      });
      const quotaRuntime = withLeafSandbox({
        spawned: 0,
        spawn(): string {
          this.spawned += 1;
          return `leaf-${String(this.spawned)}`;
        },
        collect(): {
          status: "failed";
          output: null;
          usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            reasoningTokens: number;
          };
          errorKind: string;
          retryAfter: number;
        } {
          return {
            status: "failed",
            output: null,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
            errorKind: "quota_exhausted",
            retryAfter: 120,
          };
        },
        steer(): void {},
        cancel(): void {},
      });
      const budgetService = new WorkflowService({
        runtime: successRuntime,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
        timerFactory,
      });
      // token budget pause: budget 1, two nodes spend 5 → second spawn gated, NO scheduler arm
      const budgeted = budgetService.start(
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
      if ("error" in budgeted) throw new Error(budgeted.error);
      await budgetService.status(budgeted.run_id, true);
      expect(timers.length).toBe(1); // heartbeat only
      const budgetLine = repository.getRunState(budgeted.run_id) as Record<string, unknown>;
      expect(budgetLine.pause_reason).toBe("token_budget_exhausted");
      const budgetPayload = JSON.parse(String(budgetLine.pause_payload_json)) as {
        resume_at: number | null;
      };
      expect(budgetPayload.resume_at).toBeNull();

      const quotaService = new WorkflowService({
        runtime: quotaRuntime,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
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
      expect(
        (quotaFinal as { pause_reason?: string }).pause_reason ??
          (quotaFinal as { reason?: string }).reason,
      ).toBe("quota_exhausted");
      // exactly ONE new timer over the quota stretch: the armed retry
      expect(timers.length).toBe(armedBefore + 1);
      expect(timers[timers.length - 1]?.delay).toBe(120);
      const quotaLine = repository.getRunState(quota.run_id) as Record<string, unknown>;
      expect(quotaLine.pause_reason).toBe("quota_exhausted");
      const quotaPayload = JSON.parse(String(quotaLine.pause_payload_json)) as {
        resume_at: number | null;
        attempts: number;
      };
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
      const runtime = withLeafSandbox({
        spawned: 0,
        spawn(): string {
          this.spawned += 1;
          return `leaf-${String(this.spawned)}`;
        },
        collect(): {
          status: "complete";
          output: unknown;
          usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            reasoningTokens: number;
          };
        } {
          return {
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          };
        },
        steer(): void {},
        cancel(): void {},
      });
      const service = new WorkflowService({
        runtime,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
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
      name: "c",
      owner: "foreign",
      status: "running",
      pauseReason: null,
      pausePayloadJson: null,
      specJson: "{}",
      argsJson: "{}",
      tokenBudget: null,
      tainted: false,
      progressJson: null,
      auditSegmentId: null,
      updatedAt: 1000,
      fence: 1,
      holder: "foreign",
      now: 1000,
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
        repository: spy,
        locks,
        holder: "canceller",
        ttl: 900,
        ownershipOf: () => ({ fence: 9, holder: "canceller", now: 1000 }),
        database: undefined as unknown as import("better-sqlite3").Database,
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
        bell = setTimeout(() => {
          resolveRace({ error: "WAITER HUNG" });
        }, 1_000);
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
      const runtime: ChildRuntime = withLeafSandbox({
        spawn(): string {
          // the leaf outlives the lease: TTL 900 from 1000, and it is now 1901
          ownership.now = 1000 + 901;
          return "leaf-1";
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        // no live timers: a heartbeat renewal would be a second variable
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      expect(locks.runLeaseExpiry(started.run_id, 1000)).toBe(1900);
      const result = (await service.status(started.run_id, true)) as Record<string, unknown>;
      // presented at now=1901 against expires_at=1900: refused, fail-closed
      expect(result).toMatchObject({
        error: "workflow ownership lost",
        cause: "STALE_FENCE_WRITE",
      });
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

  it("a second acquisition of the same run by the same holder never lends it the new fence", async () => {
    // The reproduced R2 failure: after the lease expired the SAME holder took
    // fence 2 while the first stretch was still in flight. The old stretch then
    // presented fence 2, wrote `complete`, and released the live stretch's
    // lease. Its own fence is 1 and it must stay there.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const clock = { now: 1000 };
      const store = () => ({
        repository,
        locks,
        holder: "same-holder",
        ttl: 10,
        ownershipOf: () => ({ fence: 0, holder: "same-holder", now: clock.now }),
        database: connection.database,
      });
      const timers = { cancel: () => undefined };
      const first = gatedRuntime(); // its leaf genuinely stays in flight
      // two SERVICES, one holder name — the same shape as two processes
      const oldService = new WorkflowService({
        runtime: first,
        idSource: () => "same-run",
        timerFactory: () => timers,
        store: store(),
      });
      const started = oldService.start(spec());
      if ("error" in started) throw new Error(started.error);
      expect(locks.runFenceOf("same-run")).toBe(1);

      clock.now = 1011; // the first stretch's lease (TTL 10) has expired
      const second = gatedRuntime(); // stays in flight, so it keeps holding the lease
      const newService = new WorkflowService({
        runtime: second,
        idSource: () => "same-run",
        timerFactory: () => timers,
        store: store(),
      });
      const resumed = newService.start(null, {}, { resumeRunId: "same-run" });
      if ("error" in resumed) throw new Error(resumed.error);
      expect(locks.runFenceOf("same-run")).toBe(2);
      const liveExpiry = locks.runLeaseExpiry("same-run", clock.now);
      expect(liveExpiry).toBe(1021);

      // now let ONLY the old stretch finish
      first.release();
      const oldOutcome = (await oldService.status("same-run", true)) as Record<string, unknown>;
      // it presented its own fence 1, which is stale: refused, fail-closed
      expect(oldOutcome).toMatchObject({
        error: "workflow ownership lost",
        cause: "STALE_FENCE_WRITE",
        fence: 1,
      });
      // it did NOT write a terminal status over the live stretch's line
      expect((repository.getRunState("same-run") as Record<string, unknown>).status).toBe(
        "running",
      );
      // and it did NOT release the live stretch's lease
      expect(locks.runLeaseExpiry("same-run", clock.now)).toBe(liveExpiry);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a run that is live in THIS process falls to the registry guard, taking no lease", async () => {
    const { service, repository, locks, runtime, close } = harness();
    runtime.releaseFirst();
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    const fenceBefore = locks.runFenceOf(started.run_id);
    const clash = service.start(null, {}, { resumeRunId: started.run_id });
    expect(clash).toMatchObject({
      error:
        `workflow run '${started.run_id}' has not finished (status: running); ` +
        "wait for it (workflow_status) or cancel it before resuming",
    });
    // the refusal acquired nothing: the fence did not move
    expect(locks.runFenceOf(started.run_id)).toBe(fenceBefore);
    expect((repository.getRunState(started.run_id) as Record<string, unknown>).status).toBe(
      "running",
    );
    // let the live stretch finish before the connection goes away
    runtime.release();
    await service.status(started.run_id, true);
    close();
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
        onEvent: (event) => {
          events.push({
            kind: event.kind,
            ...(event.state === undefined ? {} : { state: event.state }),
          });
        },
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
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

  it("after ownership loss, status and list keep saying so — no channel reports success", async () => {
    // R2: the waiter got the envelope, but a LATER status rebuilt success from
    // the engine's own outcome and list reported `complete`, while the durable
    // line still said `running`. One published answer, read by every channel.
    const { service, locks, runtime, close, repository } = harness();
    runtime.releaseFirst();
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    connection_expireLease(started.run_id);
    expect(locks.acquireRunLease(started.run_id, "thief", 1000, 900)).not.toBeNull();
    const waiter = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(waiter.error).toBe("workflow ownership lost");
    // asking again, later, must not turn it into a success
    const later = (await service.status(started.run_id)) as Record<string, unknown>;
    expect(later.error).toBe("workflow ownership lost");
    expect(later.status).toBeUndefined();
    const listed = service.list().find((entry) => entry.run_id === started.run_id);
    expect(listed?.status).toBe("ownership_lost");
    expect((repository.getRunState(started.run_id) as Record<string, unknown>).status).toBe(
      "running",
    );
    close();
  });

  it("arms the retry at the provider's retry_after, not at the backoff curve", async () => {
    // 137 is deliberately a value the exponential backoff never produces, so
    // the assertion cannot pass by arithmetic coincidence.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const armed: number[] = [];
      const runtime = withLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => ({
          status: "failed",
          output: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          errorKind: "quota_exhausted",
          retryAfter: 137,
        }),
        steer: (): void => undefined,
        cancel: (): void => undefined,
      });
      const service = new WorkflowService({
        runtime,
        // heartbeat interval is ttl/3 = 300; the retry must be distinguishable
        timerFactory: (delay) => {
          armed.push(delay);
          return { cancel: () => undefined };
        },
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.pause_reason).toBe("quota_exhausted");
      expect((final.checkpoint as Record<string, unknown>).retry_after).toBe(137);
      // 137 is neither the heartbeat (300) nor any backoff step (60,120,240,…)
      expect(armed).toContain(137);
      const payload = JSON.parse(
        String(
          (repository.getRunState(started.run_id) as Record<string, unknown>).pause_payload_json,
        ),
      ) as { resume_at: number | null };
      expect(payload.resume_at).toBe(137);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runAndWait on a resume waits for the NEW stretch, not the settled one", async () => {
    const { service, repository, close } = harness();
    const checkpointSpec = {
      meta: { name: "cp" },
      nodes: [{ id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" }],
    };
    const started = service.start(checkpointSpec);
    if ("error" in started) throw new Error(started.error);
    const first = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(first.status).toBe("paused");
    // resume takes the checkpoint's default and completes; the waiter must see
    // THAT, not the paused answer the previous stretch already settled with
    const resumed = (await service.runAndWait(null, {}, { resumeRunId: started.run_id })) as Record<
      string,
      unknown
    >;
    expect(resumed.status).toBe("complete");
    expect((repository.getRunState(started.run_id) as Record<string, unknown>).status).toBe(
      "complete",
    );
    close();
  });

  it("each cached cell tops the lease up, and progress is persisted for a cold reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const clock = { now: 1000 };
      const runtime = withLeafSandbox({
        spawn: (): string => {
          clock.now += 20;
          return `leaf-${String(clock.now)}`;
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: (): void => undefined,
        cancel: (): void => undefined,
      });
      const service = new WorkflowService({
        runtime,
        // NO heartbeat ticks: the only thing that can keep the lease alive here
        // is the per-cell top-up, and the run outlives the 30s TTL without it.
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 30,
          ownershipOf: () => ({ fence: 0, holder: "test", now: clock.now }),
          database: connection.database,
        },
      });
      const started = service.start({
        meta: { name: "long" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two ${a.answer}" },
          { id: "c", type: "agent", prompt: "three ${b.answer}" },
        ],
      });
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      // progress persisted for a reader that never saw the engine
      const progress = JSON.parse(String(line.progress_json)) as { total: number; done: number };
      expect(progress.total).toBe(3);
      expect(progress.done).toBe(3);
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
      const runtime = withLeafSandbox<ChildRuntime>({
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
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        idSource: (() => {
          let n = 0;
          return () => {
            n += 1;
            return `run-${String(n)}`;
          };
        })(),
        fenceMemory: 1,
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
      // run-1 was evicted: its terminal write is refused without ever
      // presenting a guessed token, and its waiter resolves with the envelope
      const result = (await service.status(first.run_id, true)) as Record<string, unknown>;
      expect(evicted).toBe(true);
      expect(result.error).toBe("workflow ownership lost");
      expect((repository.getRunState(first.run_id) as Record<string, unknown>).status).toBe(
        "running",
      );
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
      const runtime = withLeafSandbox({
        spawn: () => "leaf-1",
        collect: (): ChildResult => ({
          status: "failed",
          output: null,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          errorKind: kind,
          retryAfter: 300,
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        timerFactory: (delay) => {
          timers.push({ delay });
          return { cancel: () => undefined };
        },
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
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
          name: "n",
          owner: "dead",
          status: "paused",
          pauseReason: reason,
          pausePayloadJson: JSON.stringify({
            checkpoint: null,
            resume_at: null,
            attempts: 1,
            prior_faults: [],
            prior_degraded: false,
          }),
          specJson: JSON.stringify(spec()),
          argsJson: "{}",
          tokenBudget: null,
          tainted: false,
          progressJson: null,
          auditSegmentId: null,
          updatedAt: 1000,
          fence,
          holder: "dead",
          now: 1000,
        });
      };
      paused("orphan", "quota_exhausted");
      locks.releaseRunLease("orphan", "dead");
      const starved = locks.acquireRunLease("starved", "dead", 1000, 900);
      if (starved === null) throw new Error("expected lease");
      repository.putRunState("starved", {
        name: "n",
        owner: "dead",
        status: "paused",
        pauseReason: "token_budget_exhausted",
        pausePayloadJson: JSON.stringify({
          checkpoint: null,
          resume_at: null,
          attempts: 1,
          prior_faults: [],
          prior_degraded: false,
        }),
        specJson: JSON.stringify(spec()),
        argsJson: "{}",
        tokenBudget: 1,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence: starved,
        holder: "dead",
        now: 1000,
      });
      locks.releaseRunLease("starved", "dead");
      const timers: { delay: number }[] = [];
      const cold = new WorkflowService({
        runtime: runtimeStub(),
        timerFactory: (delay) => {
          timers.push({ delay });
          return { cancel: () => undefined };
        },
        store: {
          repository,
          locks,
          holder: "cold",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
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
      const results: { step: string; out: string }[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let runId = "";
      // A leaf asks for its dispatch WHILE the stretch is live — that is when
      // real leaves run, and it is the only place the acquisition's policy,
      // working root and taint are the live ones.
      const runtime = withLeafSandbox<ChildRuntime>({
        spawn(): string {
          const owner = running.service;
          if (owner !== null && results.length === 0) {
            // Through the wrapper the SERVICE installed on this runtime for
            // this acquisition — the path a real leaf's tools take.
            const dispatch = (name: string, args: Readonly<Record<string, unknown>>): string =>
              runtime.leafTool(1, name, args);
            const workingRoot = owner.workingRootFor(runId);
            mkdirSync(workingRoot, { recursive: true });
            const step = (label: string, out: string): void => {
              results.push({ step: label, out });
            };
            step(
              "inside-working-root",
              dispatch("write_file", { path: join(workingRoot, "note.txt") }),
            );
            step(
              "outside-every-root",
              dispatch("read_file", { path: join(root, "elsewhere.txt") }),
            );
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
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        policyPath: path,
        taintTracker: tracker,
        homeRoot: root,
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
        { step: "inside-working-root", out: "allowed:write_file" },
        // outside every root: exact denial, and the SPEC's fs_allow ["/"] did
        // not widen it — the policy is the operator file, only
        {
          step: "outside-every-root",
          out: "ERROR: path is outside the workflow working scope (sandbox denied)",
        },
        // under a read-only operator root: read ok, write refused with its own text
        { step: "ro-root-read", out: "allowed:read_file" },
        {
          step: "ro-root-write",
          out: "ERROR: path is under a read-only workflow root (sandbox denied the write)",
        },
        // egress: exact host match only; the spec's "*" widened nothing
        {
          step: "egress-denied",
          out: "ERROR: host is not in the workflow egress allowlist (sandbox denied)",
        },
        { step: "taint-before", out: "false" },
        // the allowed fetch runs AND taints the session
        { step: "egress-allowed", out: "allowed:web_fetch" },
        { step: "taint-after", out: "true" },
        // taint is live inside the SAME stretch: fs and egress both close
        { step: "tainted-fs", out: "ERROR: tainted run: filesystem access is disabled for leaves" },
        { step: "tainted-egress", out: "ERROR: tainted run: web egress is disabled for leaves" },
      ]);
      // a denied call never reached the base dispatch
      expect(runtime.baseCalls()).toEqual(["write_file", "read_file", "web_fetch"]);
      // and the taint the leaf picked up landed on THIS stretch's durable row
      expect(
        Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted),
      ).toBe(1);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ownership lost during install: the refused first write ends the stretch before any leaf runs", async () => {
    // The installer can block the event loop past the TTL. Another holder takes
    // the run in that window, so the FIRST owned write comes back refused —
    // which is the authoritative proof of ownership loss and must end the
    // stretch before engine.run, not surface later at the terminal write.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const clock = { now: 1000 };
      const warnings: StateWarning[] = [];
      const watched = new WorkflowRepository(connection.database, (warning) =>
        warnings.push(warning),
      );
      let spawns = 0;
      let disposals = 0;
      let takeoverFence: number | null = null;
      const timers: { cancelled: boolean }[] = [];
      const runtime: ChildRuntime = {
        installLeafSandbox: () => {
          // the takeover lands while the installer is still running
          clock.now = 1011;
          takeoverFence = locks.acquireRunLease("run-lost-in-install", "other", clock.now, 900);
          return {
            dispose: () => {
              disposals += 1;
            },
          };
        },
        spawn: () => {
          spawns += 1;
          return "leaf-1";
        },
        collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" } }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: () => "run-lost-in-install",
        timerFactory: () => {
          const timer = { cancelled: false };
          timers.push(timer);
          return {
            cancel: () => {
              timer.cancelled = true;
            },
          };
        },
        store: {
          repository: watched,
          locks,
          holder: "mine",
          ttl: 10,
          ownershipOf: () => ({ fence: 0, holder: "mine", now: clock.now }),
          database: connection.database,
        },
      });
      const started = service.start(spec());
      expect(takeoverFence).toBe(2);
      // start refuses with the contract's nominal envelope, naming OUR fence
      expect(started).toMatchObject({
        error: "workflow ownership lost",
        cause: "STALE_FENCE_WRITE",
        run_id: "run-lost-in-install",
        fence: 1,
      });
      // NO leaf ran — the refusal ended the stretch before engine.run
      expect(spawns).toBe(0);
      // this acquisition's resources are back: sandbox disposed, timers stopped
      expect(disposals).toBe(1);
      expect(timers.every((timer) => timer.cancelled)).toBe(true);
      // the new owner's lease is untouched, and its fence still stands
      expect(locks.runLeaseExpiry("run-lost-in-install", clock.now)).toBe(1911);
      expect(Number(locks.runFenceOf("run-lost-in-install"))).toBe(2);
      // nothing stale was written, and the refusal was logged with its cause
      expect(repository.getRunState("run-lost-in-install")).toBeNull();
      expect(repository.getRunSpend("run-lost-in-install")).toBeNull();
      expect(warnings.map((warning) => warning.cause as string)).toContain("STALE_FENCE_WRITE");
      // no live registry entry is left behind, and status falls through to disk
      expect(service.list().some((entry) => entry.run_id === "run-lost-in-install")).toBe(false);
      const after = (await service.status("run-lost-in-install")) as Record<string, unknown>;
      expect(after.error).toBe("unknown workflow run 'run-lost-in-install'");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a refused launch LINE alone ends the stretch before any leaf runs", () => {
    // The two initial writes share one ownership condition, so a genuine loss
    // refuses both. This plants the refusal on the LINE only, which is what
    // makes observing that particular boolean load-bearing.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let spawns = 0;
      const refusingLine = new Proxy(repository, {
        get(target, prop, receiver) {
          if (prop === "putRunState") return () => false;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const service = new WorkflowService({
        runtime: withLeafSandbox({
          spawn: (): string => {
            spawns += 1;
            return "leaf-1";
          },
          collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" } }),
          steer: (): void => undefined,
          cancel: (): void => undefined,
        }),
        idSource: () => "run-line-refused",
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository: refusingLine,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      expect(started).toMatchObject({
        error: "workflow ownership lost",
        cause: "STALE_FENCE_WRITE",
        fence: 1,
      });
      expect(spawns).toBe(0);
      // the ledger the seed DID write is the only trace, and the lease is back
      expect(locks.runLeaseExpiry("run-line-refused", 1000)).toBeNull();
      expect(service.list().some((entry) => entry.run_id === "run-line-refused")).toBe(false);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a refused ledger SEED alone ends the stretch before any leaf runs", () => {
    // Here the line lands and only the seed is refused: the stretch was evicted
    // from the bounded fence memory during install, so it has no honest token
    // to present for the ledger even though its lease is still its own.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const running: { service: WorkflowService | null } = { service: null };
      let evicted = false;
      let spawns = 0;
      const runtime: ChildRuntime = {
        installLeafSandbox: () => {
          const owner = running.service;
          if (!evicted && owner !== null) {
            evicted = true;
            // a second run takes the only fence-memory slot
            owner.start(spec());
          }
          return { dispose: () => undefined };
        },
        spawn: () => {
          spawns += 1;
          return "leaf-1";
        },
        collect: (): ChildResult => ({ status: "complete", output: { answer: "ok" } }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        fenceMemory: 1,
        idSource: (() => {
          let n = 0;
          return () => {
            n += 1;
            return `evict-${String(n)}`;
          };
        })(),
        timerFactory: () => ({ cancel: () => undefined }),
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
      const started = service.start(spec());
      expect(evicted).toBe(true);
      // the LINE landed (the lease is genuinely ours), the SEED could not
      expect(repository.getRunState("evict-1")).not.toBeNull();
      expect(repository.getRunSpend("evict-1")).toBeNull();
      expect(started).toMatchObject({
        error: "workflow ownership lost",
        cause: "STALE_FENCE_WRITE",
        fence: 1,
      });
      expect(spawns).toBe(0);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a takeover interposed between the fence check and the release keeps its lease", async () => {
    // The release used to read the fence and then DELETE by (run, holder). A
    // new acquisition BY THE SAME HOLDER landing between those two statements
    // passed the stale check and had its lease deleted. The takeover is
    // interposed here at exactly that point, deterministically.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const clock = { now: 1000 };
      let interposed = false;
      let takeoverFence: number | null = null;
      // The proxy fires the competing acquire the instant the cleanup reaches
      // its release — the window the old read-then-delete left open.
      const racingLocks = new Proxy(locks, {
        get(target, prop, receiver) {
          if (prop === "releaseRunLeaseAtFence" || prop === "releaseRunLease") {
            return (...args: unknown[]) => {
              if (!interposed) {
                interposed = true;
                // the finishing stretch's own lease (TTL 10) has lapsed, so a
                // fresh acquisition by the SAME holder takes the run over here
                clock.now = 1011;
                takeoverFence = target.acquireRunLease(
                  "run-release-race",
                  "same-holder",
                  clock.now,
                  900,
                );
              }
              return (target[prop as "releaseRunLease"] as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const service = new WorkflowService({
        runtime: withLeafSandbox({
          spawn: (): string => "leaf-1",
          collect: (): ChildResult => ({
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          }),
          steer: (): void => undefined,
          cancel: (): void => undefined,
        }),
        idSource: () => "run-release-race",
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks: racingLocks,
          holder: "same-holder",
          ttl: 10,
          ownershipOf: () => ({ fence: 0, holder: "same-holder", now: clock.now }),
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status("run-release-race", true);
      expect(interposed).toBe(true);
      expect(takeoverFence).toBe(2);
      expect(Number(locks.runFenceOf("run-release-race"))).toBe(2);
      // the takeover's lease SURVIVES the finishing stretch's cleanup
      expect(locks.runLeaseExpiry("run-release-race", clock.now)).toBe(1911);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an installer that throws gives the lease back and stops the heartbeat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const timers: { cancelled: boolean }[] = [];
      const warnings: string[] = [];
      let spawns = 0;
      const exploding: ChildRuntime = {
        installLeafSandbox: () => {
          throw new Error("installer exploded");
        },
        spawn: () => {
          spawns += 1;
          return "leaf-1";
        },
        collect: (): ChildResult => ({ status: "complete", output: null }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime: exploding,
        idSource: () => "run-install-throws",
        onWarning: (message) => warnings.push(message),
        timerFactory: () => {
          const timer = { cancelled: false };
          timers.push(timer);
          return {
            cancel: () => {
              timer.cancelled = true;
            },
          };
        },
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      // the exception never escapes: the caller gets the nominal envelope
      const started = service.start(spec());
      expect(started).toMatchObject({
        error: "workflow leaf sandbox unavailable",
        cause: "LEAF_SANDBOX_UNAVAILABLE",
        run_id: "run-install-throws",
      });
      expect(spawns).toBe(0);
      // lease given back, no durable row, and no timer left able to renew it
      expect(locks.runLeaseExpiry("run-install-throws", 1000)).toBeNull();
      expect(repository.getRunState("run-install-throws")).toBeNull();
      expect(timers.every((timer) => timer.cancelled)).toBe(true);
      // the fence row survives (it always does) and the failure was recorded
      expect(Number(locks.runFenceOf("run-install-throws"))).toBe(1);
      expect(warnings.some((message) => message.includes("installer exploded"))).toBe(true);
      // and the run is launchable again afterwards — nothing was left holding it
      const retry = new WorkflowService({
        runtime: withLeafSandbox({
          spawn: (): string => "leaf-1",
          collect: (): ChildResult => ({
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          }),
          steer: (): void => undefined,
          cancel: (): void => undefined,
        }),
        idSource: () => "run-install-throws",
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const second = retry.start(spec());
      if ("error" in second) throw new Error(second.error);
      const done = (await retry.status("run-install-throws", true)) as Record<string, unknown>;
      expect(done.status).toBe("complete");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a disposer that throws still lets the run publish a bounded, coherent result", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const warnings: string[] = [];
      let disposeCalls = 0;
      const runtime: ChildRuntime = {
        installLeafSandbox: () => ({
          dispose: () => {
            disposeCalls += 1;
            throw new Error("dispose exploded");
          },
        }),
        spawn: () => "leaf-1",
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: () => "run-dispose-throws",
        onWarning: (message) => warnings.push(message),
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      // BOUNDED: the waiter settles on its own, it does not hang on a rejected chain
      let bell: ReturnType<typeof setTimeout> | undefined;
      const waited = (await Promise.race([
        service.status("run-dispose-throws", true),
        new Promise<Record<string, unknown>>((resolveRace) => {
          bell = setTimeout(() => {
            resolveRace({ error: "WAITER HUNG" });
          }, 1_000);
        }),
      ])) as Record<string, unknown>;
      clearTimeout(bell);
      expect(waited.status).toBe("complete");
      // cleanup is idempotent: disposal is attempted once, not once per path
      expect(disposeCalls).toBe(1);
      expect(warnings.some((message) => message.includes("dispose exploded"))).toBe(true);
      // and every channel agrees, with the lease handed back
      expect((repository.getRunState("run-dispose-throws") as Record<string, unknown>).status).toBe(
        "complete",
      );
      expect(service.list().find((entry) => entry.run_id === "run-dispose-throws")?.status).toBe(
        "complete",
      );
      expect(locks.runLeaseExpiry("run-dispose-throws", 1000)).toBeNull();
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      expect(rejections).toEqual([]);
      connection.close();
    } finally {
      process.off("unhandledRejection", onRejection);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a publish that throws after cleanup does not hand the acquisition back twice", async () => {
    // The reachable double-cleanup path: the terminal handler finishes the
    // stretch, then building the published view throws (a leaf output that
    // cannot be structured-cloned), so the chain lands in `.catch` — which
    // finishes the stretch again. Cleanup must be idempotent, and the run must
    // still publish something bounded.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-durability-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let disposeCalls = 0;
      let releaseCalls = 0;
      const countingLocks = new Proxy(locks, {
        get(target, prop, receiver) {
          if (prop === "releaseRunLeaseAtFence" || prop === "releaseRunLease") {
            return (...args: unknown[]) => {
              releaseCalls += 1;
              return (target[prop as "releaseRunLease"] as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      const runtime: ChildRuntime = {
        installLeafSandbox: () => ({
          dispose: () => {
            disposeCalls += 1;
          },
        }),
        spawn: () => "leaf-1",
        collect: (): ChildResult => ({
          status: "complete",
          // a function cannot be structured-cloned, so publishing this throws
          output: { answer: () => "nope" },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime,
        idSource: () => "run-publish-throws",
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks: countingLocks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      let bell: ReturnType<typeof setTimeout> | undefined;
      const waited = (await Promise.race([
        service.status("run-publish-throws", true),
        new Promise<Record<string, unknown>>((resolveRace) => {
          bell = setTimeout(() => {
            resolveRace({ error: "WAITER HUNG" });
          }, 1_000);
        }),
      ])) as Record<string, unknown>;
      clearTimeout(bell);
      // bounded: the waiter settles with the failure envelope, it does not hang
      expect(waited.status).toBe("failed");
      // and the acquisition was handed back exactly ONCE, not once per path
      expect(disposeCalls).toBe(1);
      expect(releaseCalls).toBe(1);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to launch a durable run when the runtime cannot install the leaf sandbox", async () => {
    // Fail-closed: no lease is kept, no line is written, and nothing spawns.
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      let spawns = 0;
      const bare: ChildRuntime = {
        spawn: () => {
          spawns += 1;
          return "leaf-1";
        },
        collect: (): ChildResult => ({ status: "complete", output: null }),
        steer: () => undefined,
        cancel: () => undefined,
      };
      const service = new WorkflowService({
        runtime: bare,
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      expect(started).toMatchObject({
        error: "workflow leaf sandbox unavailable",
        cause: "LEAF_SANDBOX_UNAVAILABLE",
      });
      expect(spawns).toBe(0);
      // the refused launch sat on nothing: no lease, no durable line
      expect(locks.runLeaseExpiry("run-1", 1000)).toBeNull();
      expect(repository.recentRunStates(10).length).toBe(0);
      // a runtime that CAN install it launches the same spec fine
      const sandboxed = new WorkflowService({
        runtime: withLeafSandbox({
          spawn: () => "leaf-1",
          collect: (): ChildResult => ({
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          }),
          steer: () => undefined,
          cancel: () => undefined,
        }),
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const ok = sandboxed.start(spec());
      if ("error" in ok) throw new Error(ok.error);
      const done = (await sandboxed.status(ok.run_id, true)) as Record<string, unknown>;
      expect(done.status).toBe("complete");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs one sandbox per ACQUISITION and disposes only its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      // The SECOND acquisition's leaf stays in flight, so stretch 2 is current
      // while we ask stretch 1's retired wrapper for capability.
      let openSecond!: () => void;
      const secondLeaf = new Promise<void>((resolveLeaf) => {
        openSecond = resolveLeaf;
      });
      let spawns = 0;
      const runtime = withLeafSandbox({
        spawn: (): string => {
          spawns += 1;
          return `leaf-${String(spawns)}`;
        },
        collect: async (id: string): Promise<ChildResult> => {
          if (id === "leaf-2") await secondLeaf;
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
      });
      const service = new WorkflowService({
        runtime,
        homeRoot: root,
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const first = service.start(spec());
      if ("error" in first) throw new Error(first.error);
      await service.status(first.run_id, true);
      // fence 1 installed and then disposed — its own, by fence
      expect(runtime.disposedFences()).toEqual([1]);
      expect(runtime.installedFences()).toEqual([]);
      // a second acquisition of the SAME run installs under its own fence, and
      // stays in flight so it is the CURRENT stretch for the assertion below
      const second = service.start(null, {}, { resumeRunId: first.run_id });
      if ("error" in second) throw new Error(second.error);
      expect(runtime.installedFences()).toEqual([2]);
      // stretch 1's wrapper grants nothing now that stretch 2 owns the run —
      // even for a path inside stretch 1's own former working root
      mkdirSync(join(root, "runs", first.run_id, "work-1"), { recursive: true });
      expect(
        runtime.retiredTool(1, "write_file", {
          path: join(root, "runs", first.run_id, "work-1", "x.txt"),
        }),
      ).toBe("ERROR: workflow stretch is no longer current (sandbox denied)");
      // stretch 2's own wrapper still works, in its own root
      mkdirSync(join(root, "runs", first.run_id, "work-2"), { recursive: true });
      expect(
        runtime.leafTool(2, "write_file", {
          path: join(root, "runs", first.run_id, "work-2", "x.txt"),
        }),
      ).toBe("allowed:write_file");
      openSecond();
      await service.status(first.run_id, true);
      expect(runtime.disposedFences()).toEqual([1, 2]);
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
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      expect(
        Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted),
      ).toBe(0);
      // a leaf taints the session, then the run is resumed by a FRESH service
      service.leafToolDispatch(started.run_id, () => "OK")("web_search", { query: "x" });
      expect(tracker.tainted).toBe(true);
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      expect(
        Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted),
      ).toBe(1);
      // a brand-new process (clean tracker) still gets a tainted stretch
      const cold = new WorkflowService({
        runtime: runtimeStub(),
        policyPath: path,
        taintTracker: new TaintTracker(),
        homeRoot: root,
        store: {
          repository,
          locks,
          holder: "cold",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const again = cold.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in again) throw new Error(again.error);
      await cold.status(started.run_id, true);
      expect(
        cold.leafToolDispatch(started.run_id, () => "OK")("read_file", {
          path: join(root, "a.txt"),
        }),
      ).toBe("ERROR: tainted run: filesystem access is disabled for leaves");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("delivered evidence normalization", () => {
  /** One captured artifact, parameterised only by the volatile values. */
  function artifact(runId: string, today: string): string {
    return JSON.stringify({
      verdict: "match",
      runs: {
        oracle: {
          events: {
            requests: {
              records: [
                {
                  body: {
                    messages: [
                      { role: "system", content: `You are lohra.\n\nToday's date is ${today}.` },
                      { role: "user", content: "Today's date is 2031-03-04." },
                      { role: "tool", content: "Today's date is 2042-05-06." },
                    ],
                  },
                },
                {
                  body: {
                    messages: [
                      {
                        role: "tool",
                        content: `{"ok": true, "run_id": "${runId}", "status": "started"}`,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      oracleGuard: { commit: "16b4785d803ad0ca364a8a67346a04f949fbf592" },
    });
  }

  it("the same fixture captured on two different dates delivers identical bytes", () => {
    // The handoff digests stopped verifying once the clock rolled over: both
    // sides state the current date in the system prompt.
    const monday = artifact("5fed570d32bd48309293b1123f6ca744", "2026-01-02");
    const newYearsEve = artifact("d63a44a8c7ef47738fe648d4a6926770", "2026-12-31");
    expect(monday).not.toBe(newYearsEve);
    expect(normalizeEvidence(monday)).toBe(normalizeEvidence(newYearsEve));
    expect(normalizeEvidence(monday)).toContain("Today's date is <date>.");
    expect(normalizeEvidence(monday)).toContain('\\"run_id\\": \\"<run-id>');
  });

  it("normalizes ONLY the two declared volatile values, masking nothing else", () => {
    const before = artifact("5fed570d32bd48309293b1123f6ca744", "2026-01-02");
    const after = normalizeEvidence(before);
    // every other captured field survives byte for byte
    expect(after).toContain('"verdict":"match"');
    expect(after).toContain('"role":"system"');
    expect(after).toContain("You are lohra.");
    expect(after).toContain('"status\\": \\"started');
    expect(after.match(/Today's date is <date>\./g)).toHaveLength(1);
    expect(after).toContain(`"role":"user","content":"Today's date is 2031-03-04."`);
    expect(after).toContain(`"role":"tool","content":"Today's date is 2042-05-06."`);
    // the oracle SHA is 40 hex characters and must NOT be swept up by the id rule
    expect(after).toContain("16b4785d803ad0ca364a8a67346a04f949fbf592");
    // and the rules are the declared ones, recorded with the evidence
    expect(EVIDENCE_NORMALIZATIONS.map((rule) => rule.field)).toEqual([
      "run_id",
      "system_prompt.today",
    ]);
    expect(EVIDENCE_NORMALIZATIONS[1]?.kind).toBe("structural-replace-regex");
    expect(EVIDENCE_NORMALIZATIONS[1]?.scope).toContain("role is exactly system");
  });
});
