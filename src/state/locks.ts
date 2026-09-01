import type Database from "better-sqlite3";

import { safeInteger } from "./values.js";

declare const fenceBrand: unique symbol;
export type FenceToken = number & { readonly [fenceBrand]: true };

export interface StateWarning {
  readonly cause: "STALE_FENCE_WRITE";
  readonly runId: string;
  readonly fence: number;
}

function isConstraint(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error.message)
  );
}

export class LockRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly warning: (warning: StateWarning) => void = () => undefined,
  ) {}

  public acquireCompressionLock(
    sessionId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): boolean {
    try {
      return this.database
        .transaction(() => {
          this.database
            .prepare("DELETE FROM compression_locks WHERE session_id = ? AND expires_at <= ?")
            .run(sessionId, now);
          this.database
            .prepare(
              `INSERT INTO compression_locks
             (session_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
            )
            .run(sessionId, holder, now, now + ttlSeconds);
          return true;
        })
        .immediate();
    } catch (error) {
      if (
        isConstraint(error) ||
        (error instanceof Error && /database is locked/i.test(error.message))
      ) {
        return false;
      }
      throw error;
    }
  }

  public releaseCompressionLock(sessionId: string, holder: string): boolean {
    try {
      const result = this.database
        .prepare("DELETE FROM compression_locks WHERE session_id = ? AND holder = ?")
        .run(sessionId, holder);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) return false;
      throw error;
    }
  }

  public acquireRunLease(
    runId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): FenceToken | null {
    try {
      return this.database
        .transaction(() => {
          this.database
            .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND expires_at <= ?")
            .run(runId, now);
          this.database
            .prepare(
              `INSERT INTO workflow_run_locks
             (run_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
            )
            .run(runId, holder, now, now + ttlSeconds);
          this.database
            .prepare(
              `INSERT OR IGNORE INTO workflow_run_fence
             (run_id, fence, updated_at) VALUES (?, 0, ?)`,
            )
            .run(runId, now);
          this.database
            .prepare(
              "UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ? WHERE run_id = ?",
            )
            .run(now, runId);
          const row = this.database
            .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")
            .get(runId) as { readonly fence: bigint };
          return safeInteger(row.fence, "workflow_run_fence.fence") as FenceToken;
        })
        .immediate();
    } catch (error) {
      if (
        isConstraint(error) ||
        (error instanceof Error && /database is locked/i.test(error.message))
      ) {
        return null;
      }
      throw error;
    }
  }

  public releaseRunLease(runId: string, holder: string): boolean {
    try {
      const result = this.database
        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")
        .run(runId, holder);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) return false;
      throw error;
    }
  }

  /**
   * Release ONLY the lease this acquisition still holds.
   *
   * `releaseRunLease` deletes by (run_id, holder), so a caller that first reads
   * the fence and then releases leaves a window: a new acquisition BY THE SAME
   * HOLDER can take over in between, the stale check still passes, and the
   * delete removes the live lease. The fence lives in a sibling table, so the
   * condition rides inside the DELETE's own statement — there is no window to
   * interpose an acquire into.
   */
  public releaseRunLeaseAtFence(runId: string, holder: string, fence: number): boolean {
    try {
      const result = this.database
        .prepare(
          `DELETE FROM workflow_run_locks
           WHERE run_id = ? AND holder = ?
             AND EXISTS (
               SELECT 1 FROM workflow_run_fence WHERE run_id = ? AND fence = ?
             )`,
        )
        .run(runId, holder, runId, fence);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) return false;
      throw error;
    }
  }

  public renewRunLease(runId: string, holder: string, now: number, ttlSeconds: number): boolean {
    try {
      const result = this.database
        .prepare(
          `UPDATE workflow_run_locks SET expires_at = ?
           WHERE run_id = ? AND holder = ? AND expires_at > ?`,
        )
        .run(now + ttlSeconds, runId, holder, now);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) return false;
      throw error;
    }
  }

  public runLeaseExpiry(runId: string, now: number): number | null {
    const row = this.database
      .prepare(
        "SELECT expires_at FROM workflow_run_locks WHERE run_id = ? AND expires_at > ?",
      )
      .get(runId, now) as { readonly expires_at: bigint } | undefined;
    return row === undefined
      ? null
      : safeInteger(row.expires_at, "workflow_run_locks.expires_at");
  }

  public runFenceOf(runId: string): FenceToken | null {
    const row = this.database
      .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")
      .get(runId) as { readonly fence: bigint } | undefined;
    return row === undefined
      ? null
      : (safeInteger(row.fence, "workflow_run_fence.fence") as FenceToken);
  }

  public tryWriteProbeRunState(
    runId: string,
    owner: string,
    status: string,
    updatedAt: number,
    fence: FenceToken,
  ): boolean {
    const result = this.database
      .prepare(
        `INSERT OR REPLACE INTO workflow_run_state
         (run_id, owner, status, updated_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM workflow_run_fence WHERE run_id = ? AND fence > ?
         )`,
      )
      .run(runId, owner, status, updatedAt, runId, fence);
    if (result.changes > 0) return true;
    this.warning({ cause: "STALE_FENCE_WRITE", runId, fence });
    return false;
  }
}
