import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
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
    // the run-level ledger landed BEFORE the lease was released
    expect(repository.getRunSpend(started.run_id)).not.toBeNull();
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
        store: { repository: proxy, locks, holder: "test", ttl: 900, ownershipOf: () => ownership },
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

  it("runAndWait resolves bounded with the errata envelope when the terminal write loses ownership", async () => {
    // A live lease cannot be stolen — the loser's acquire returns null (busy).
    // The ownership-loss window is post-TTL-expiry: the stretch's lease expires
    // while the leaf is in flight, another process acquires, and the stretch's
    // terminal write then presents an expired lease and must be refused.
    const { service, locks, ownership, runtime, close } = harness();
    runtime.releaseFirst(); // arm the gate BEFORE start: leaf 1 blocks in flight
    const started = service.start(spec());
    if ("error" in started) throw new Error(started.error);
    // Expire the stretch's lease and let a new owner in while the leaf flies.
    connection_expireLease(started.run_id);
    const thiefFence = locks.acquireRunLease(started.run_id, "thief", 1000, 900);
    if (thiefFence === null) throw new Error("thief should have won after expiry");
    ownership.fence = 99; // the stretch's writes now present a stale token
    const result = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(result).toMatchObject({
      error: "workflow ownership lost",
      cause: "STALE_FENCE_WRITE",
      run_id: started.run_id,
    });
    close();
  });
});
