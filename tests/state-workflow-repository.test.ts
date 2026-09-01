import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
  type StateWarning,
} from "../src/state/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function repo(warnings: StateWarning[] = []) {
  const root = mkdtempSync(join(tmpdir(), "lohra-wf-repo-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    repository: new WorkflowRepository(connection.database, (warning) =>
      warnings.push(warning),
    ),
    locks: new LockRepository(connection.database, (warning) => warnings.push(warning)),
    database: connection.database,
    close: () => { connection.close(); },
  };
}

function owned(
  value: ReturnType<LockRepository["acquireRunLease"]>,
  holder: string,
  now: number,
): { fence: number; holder: string; now: number } {
  if (value === null) throw new Error("expected lease token");
  return { fence: value, holder, now };
}

function writeState(
  repository: ReturnType<typeof repo>["repository"],
  runId: string,
  ownership: { fence: number; holder: string; now: number },
  status = "running",
): boolean {
  return repository.putRunState(runId, {
    name: "n",
    owner: ownership.holder,
    status,
    pauseReason: null,
    pausePayloadJson: null,
    specJson: JSON.stringify({ meta: { name: "n" }, nodes: [] }),
    argsJson: "{}",
    tokenBudget: 100,
    tainted: false,
    progressJson: null,
    auditSegmentId: null,
    updatedAt: ownership.now,
    fence: ownership.fence,
    holder: ownership.holder,
    now: ownership.now,
  });
}

describe("workflow repository — owned writes demand live ownership", () => {
  it("refuses every owned write when the presented fence is stale (H1)", () => {
    const { repository, locks, database, close } = repo();
    const first = owned(locks.acquireRunLease("run", "p1", 1000, 100), "p1", 1000);
    expect(writeState(repository, "run", first)).toBe(true);
    expect(locks.releaseRunLease("run", "p1")).toBe(true);
    const second = owned(locks.acquireRunLease("run", "p2", 1001, 100), "p2", 1001);
    // stale fence F-1 against a live owner: refused for all four categories
    const stale = { fence: (first.fence - 1), holder: "p1", now: 1002 };
    expect(stale.fence).toBeLessThan(second.fence);
    expect(writeState(repository, "run", stale)).toBe(false);
    expect(repository.putCacheCell("run", "h1", "node", "{}", "complete", stale)).toBe(false);
    expect(
      repository.putCacheCost("run", "h1", 1, 2, 0, 0, 0, stale),
    ).toBe(false);
    expect(repository.putRunSpend("run", 100, 1, 2, 0, 0, 0, stale)).toBe(false);
    // forged/future fence is refused too (exact equality, not >=)
    expect(writeState(repository, "run", { ...second, fence: second.fence + 1 })).toBe(false);
    // nothing extra was written
    expect(Number(
      (database.prepare("SELECT count(*) AS n FROM workflow_node_cache").get() as { n: bigint }).n,
    )).toBe(0);
    close();
  });

  it("refuses writes after release and after TTL expiry, and with a wrong holder (H1)", () => {
    const { repository, locks, database, close } = repo();
    const first = owned(locks.acquireRunLease("run", "p1", 1000, 50), "p1", 1000);
    expect(writeState(repository, "run", first)).toBe(true);
    // post-release: fence still current, holder still recorded, lease gone
    expect(locks.releaseRunLease("run", "p1")).toBe(true);
    expect(writeState(repository, "run", first)).toBe(false);
    // wrong holder while lease is live: p2's acquire bumps the fence, so the
    // new owner writes with ITS token; the old owner's (fence, holder) pair fails
    const second = owned(locks.acquireRunLease("run", "p2", 1001, 100), "p2", 1001);
    expect(writeState(repository, "run", second)).toBe(true);
    expect(writeState(repository, "run", first)).toBe(false);
    // post-TTL expiry: nobody may write with the old lease
    expect(writeState(repository, "run", { ...first, now: 1001 + 101 })).toBe(false);
    const row = database
      .prepare("SELECT status FROM workflow_run_state WHERE run_id = 'run'")
      .get() as { readonly status: string } | undefined;
    expect(row?.status).toBe("running");
    close();
  });

  it("renews only the live holder's still-valid lease (H2)", () => {
    const { locks, database, close } = repo();
    expect(locks.acquireRunLease("run", "p1", 1000, 50)).not.toBeNull();
    expect(locks.renewRunLease("run", "p1", 1020, 50)).toBe(true);
    expect(locks.runLeaseExpiry("run", 1020)).toBe(1070);
    // another holder cannot renew
    expect(locks.renewRunLease("run", "p2", 1030, 50)).toBe(false);
    // after expiry the old holder cannot resurrect the lease, even pre-reacquire
    expect(locks.renewRunLease("run", "p1", 1121, 50)).toBe(false);
    expect(locks.runLeaseExpiry("run", 1121)).toBeNull();
    const row = database
      .prepare("SELECT expires_at FROM workflow_run_locks WHERE run_id = 'run'")
      .get() as { readonly expires_at: bigint } | undefined;
    expect(row === undefined || Number(row.expires_at) <= 1121).toBe(true);
    close();
  });

  it("keeps the fence row alive across releases and advances it per acquisition", () => {
    const { locks, close } = repo();
    const first = owned(locks.acquireRunLease("run", "p1", 1000, 50), "p1", 1000);
    expect(locks.releaseRunLease("run", "p1")).toBe(true);
    expect(locks.runFenceOf("run")).toBe(first.fence);
    const second = locks.acquireRunLease("run", "p2", 1001, 50);
    expect(second).toBe(first.fence + 1);
    close();
  });

  it("stores combined cache+cost in one transaction: priced or absent", () => {
    const { repository, locks, close } = repo();
    const first = owned(locks.acquireRunLease("run", "p1", 1000, 50), "p1", 1000);
    expect(
      repository.putCacheCellWithCost("run", "h1", "node", '{"v":1}', "complete", first, {
        tokensIn: 5,
        tokensOut: 3,
        cacheRead: 1,
        cacheWrite: 2,
        reasoning: 4,
      }),
    ).toBe(true);
    expect(repository.getCacheCell("run", "h1")).toEqual({
      status: "complete",
      outputJson: '{"v":1}',
    });
    expect(repository.getCacheCost("run", "h1")).toEqual({
      tokensIn: 5,
      tokensOut: 3,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 4,
    });
    // refused cell rolls back the cost half: priced or absent
    const stale = { ...first, fence: first.fence - 1 };
    expect(
      repository.putCacheCellWithCost("run", "h2", "node", "{}", "complete", stale, {
        tokensIn: 9,
        tokensOut: 9,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ).toBe(false);
    expect(repository.getCacheCell("run", "h2")).toBeNull();
    expect(repository.getCacheCost("run", "h2")).toBeNull();
    // cost exception (unsafe integer) rolls back the cell and propagates
    expect(() =>
      repository.putCacheCellWithCost("run", "h3", "node", "{}", "complete", first, {
        tokensIn: 2 ** 53,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ).toThrow();
    expect(repository.getCacheCell("run", "h3")).toBeNull();
    close();
  });

  it("refuses spend and cache writes through the same shared guard shape", () => {
    const warnings: StateWarning[] = [];
    const { repository, locks, close } = repo(warnings);
    const first = owned(locks.acquireRunLease("run", "p1", 1000, 50), "p1", 1000);
    expect(repository.putRunSpend("run", 100, 1, 2, 0, 0, 0, first)).toBe(true);
    expect(repository.putCacheCell("run", "h", "node", "{}", "complete", first)).toBe(true);
    const stale = { ...first, fence: first.fence - 1 };
    expect(repository.putRunSpend("run", 100, 3, 3, 0, 0, 0, stale)).toBe(false);
    expect(repository.putCacheCell("run", "h2", "node", "{}", "complete", stale)).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const causes = warnings.map((warning) => warning.cause as string);
    expect(causes.every((cause) => cause === "STALE_FENCE_WRITE")).toBe(true);
    close();
  });
});
