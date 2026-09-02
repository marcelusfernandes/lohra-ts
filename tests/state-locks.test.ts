import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockRepository, openStateDatabase, type StateWarning } from "../src/state/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function locks(warnings: StateWarning[] = []) {
  const root = mkdtempSync(join(tmpdir(), "lohra-state-locks-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    repo: new LockRepository(connection.database, (warning) => warnings.push(warning)),
    database: connection.database,
    close: () => {
      connection.close();
    },
  };
}

function token(value: ReturnType<LockRepository["acquireRunLease"]>) {
  if (value === null) throw new Error("expected lease token");
  return value;
}

describe("state locks and fencing", () => {
  it("recovers a dead compression owner after TTL and enforces holder release", () => {
    const { repo, close } = locks();
    expect(repo.acquireCompressionLock("s", "p1", 10, 5)).toBe(true);
    expect(repo.acquireCompressionLock("s", "p2", 11, 5)).toBe(false);
    expect(repo.releaseCompressionLock("s", "wrong")).toBe(false);
    expect(repo.acquireCompressionLock("s", "p2", 15, 5)).toBe(true);
    expect(repo.releaseCompressionLock("s", "p2")).toBe(true);
    close();
  });

  it("keeps fence monotonic across releases and rejects stale writes in one SQL", () => {
    const warnings: StateWarning[] = [];
    const { repo, database, close } = locks(warnings);
    const first = repo.acquireRunLease("run", "p1", 10, 1);
    expect(first).toBe(1);
    expect(repo.tryWriteProbeRunState("run", "p1", "running", 10, token(first))).toBe(true);
    expect(repo.releaseRunLease("run", "p1")).toBe(true);
    const second = repo.acquireRunLease("run", "p2", 11, 1);
    expect(second).toBe(2);
    expect(repo.tryWriteProbeRunState("run", "p2", "running", 11, token(second))).toBe(true);
    expect(repo.tryWriteProbeRunState("run", "p1", "complete", 12, token(first))).toBe(false);
    expect(warnings).toEqual([{ cause: "STALE_FENCE_WRITE", runId: "run", fence: 1 }]);
    expect(
      database.prepare("SELECT owner, status FROM workflow_run_state WHERE run_id = 'run'").get(),
    ).toEqual({ owner: "p2", status: "running" });
    expect(repo.releaseRunLease("run", "p2")).toBe(true);
    const third = repo.acquireRunLease("run", "p3", 12, 1);
    expect(third).toBe(3);
    expect(repo.releaseRunLease("run", "p3")).toBe(true);
    expect(repo.runFenceOf("run")).toBe(3);
    close();
  });
});
