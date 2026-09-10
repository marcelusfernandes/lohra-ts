import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LockRepository,
  openStateDatabase,
  SessionRepository,
  type StateWarning,
} from "../src/state/index.js";

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

// Issue #252: SessionRepository owns its own LockRepository over the same
// connection, so compactHistory can refuse to write without the lock in one
// atomic check (invariant 4), and two independent connections against the
// SAME file stand in for two OS processes racing the same session's lock.
function sessionRepo(path: string) {
  const connection = openStateDatabase(path);
  return {
    repo: new SessionRepository(connection.database, undefined, connection.ftsEnabled),
    close: () => {
      connection.close();
    },
  };
}

describe("SessionRepository.compactHistory", () => {
  it("rewrites the active history: summary first, kept tail after it, in order", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-compact-"));
    roots.push(root);
    const { repo, close } = sessionRepo(join(root, "state.db"));
    repo.createSession({ id: "s", systemPrompt: "sys" });
    for (let turn = 1; turn <= 5; turn += 1) {
      repo.recordTurn("s", {
        user: { role: "user", content: `q${String(turn)}` },
        assistant: { role: "assistant", content: `a${String(turn)}`, finishReason: "stop" },
      });
    }
    expect(repo.acquireCompressionLock("s", "h", 100, 30)).toBe(true);
    const result = repo.compactHistory("s", "h", 100, { keepTailCount: 4, summary: "recap" });
    expect(result).toEqual({ summarizedCount: 6, keptCount: 4 });

    const history = repo.loadMessages("s");
    expect(history).toHaveLength(5); // 1 summary + 4 kept
    expect(history[0]).toMatchObject({
      role: "assistant",
      content: "recap",
      finish_reason: "stop",
    });
    expect(history.slice(1)).toEqual([
      { role: "user", content: "q4" },
      { role: "assistant", content: "a4", finish_reason: "stop" },
      { role: "user", content: "q5" },
      { role: "assistant", content: "a5", finish_reason: "stop" },
    ]);
    close();
  });

  it("refuses to write when the caller doesn't currently hold the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-compact-"));
    roots.push(root);
    const { repo, close } = sessionRepo(join(root, "state.db"));
    repo.createSession({ id: "s", systemPrompt: "sys" });
    repo.recordTurn("s", {
      user: { role: "user", content: "q" },
      assistant: { role: "assistant", content: "a" },
    });
    expect(() =>
      repo.compactHistory("s", "nobody-acquired-for-this-holder", 100, {
        keepTailCount: 0,
        summary: "recap",
      }),
    ).toThrow(/COMPRESSION_LOCK_NOT_HELD/);
    expect(repo.loadMessages("s")).toHaveLength(2); // untouched
    close();
  });

  it("is a no-op (summarizedCount: 0) when the kept tail already covers the whole history", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-compact-"));
    roots.push(root);
    const { repo, close } = sessionRepo(join(root, "state.db"));
    repo.createSession({ id: "s", systemPrompt: "sys" });
    repo.recordTurn("s", {
      user: { role: "user", content: "q" },
      assistant: { role: "assistant", content: "a" },
    });
    expect(repo.acquireCompressionLock("s", "h", 100, 30)).toBe(true);
    const result = repo.compactHistory("s", "h", 100, { keepTailCount: 50, summary: "recap" });
    expect(result).toEqual({ summarizedCount: 0, keptCount: 2 });
    expect(repo.loadMessages("s")).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a", finish_reason: null },
    ]);
    close();
  });
});

describe("compression lock across processes", () => {
  it("blocks a second connection until the holder releases or the TTL expires", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-compact-cross-"));
    roots.push(root);
    const path = join(root, "state.db");
    const a = sessionRepo(path);
    const b = sessionRepo(path);
    try {
      expect(a.repo.acquireCompressionLock("s", "procA", 100, 30)).toBe(true);
      expect(b.repo.acquireCompressionLock("s", "procB", 105, 30)).toBe(false);
      expect(() =>
        b.repo.compactHistory("s", "procB", 105, { keepTailCount: 0, summary: "x" }),
      ).toThrow(/COMPRESSION_LOCK_NOT_HELD/);

      expect(a.repo.releaseCompressionLock("s", "procA")).toBe(true);
      expect(b.repo.acquireCompressionLock("s", "procB", 106, 30)).toBe(true);

      // procA's own release is a no-op now -- procB already holds the row.
      expect(a.repo.releaseCompressionLock("s", "procA")).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  it("recovers a lock abandoned past its TTL without a manual release", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-compact-cross-"));
    roots.push(root);
    const path = join(root, "state.db");
    const a = sessionRepo(path);
    const b = sessionRepo(path);
    try {
      expect(a.repo.acquireCompressionLock("s", "procA", 100, 5)).toBe(true);
      expect(b.repo.acquireCompressionLock("s", "procB", 104, 30)).toBe(false); // still live
      expect(b.repo.acquireCompressionLock("s", "procB", 106, 30)).toBe(true); // expired at 105
    } finally {
      a.close();
      b.close();
    }
  });
});
