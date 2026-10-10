import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

const GUARD_WAIT_MS = 2_000;

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Serializes short, synchronous operations on one jobs.json across processes.
 * SQLite's IMMEDIATE writer transaction fences the callback itself: it remains
 * held through a future JSON rename, and the OS releases it if the process dies.
 * There is no TTL that can steal a live but paused holder. A separate sidecar
 * keeps this internal primitive independent of the application's state.db.
 */
export function withCronStoreGuard<T>(path: string, fn: () => SyncResult<T>): T {
  const guardPath = `${path}.guard.sqlite`;
  let database: Database.Database | undefined;
  const callbackState = { failed: false };
  try {
    mkdirSync(dirname(guardPath), { recursive: true });
    database = new Database(guardPath, { timeout: GUARD_WAIT_MS });
    const guarded = database.transaction(() => {
      try {
        const result = fn();
        if (isPromiseLike(result)) {
          throw new TypeError("cron store guard callback must be synchronous");
        }
        return result;
      } catch (error) {
        callbackState.failed = true;
        throw error;
      }
    });
    return guarded.immediate();
  } catch (error) {
    if (callbackState.failed) throw error;
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
      throw new Error(
        `cron store guard timed out after ${String(GUARD_WAIT_MS)} ms waiting for ${path}`,
        {
          cause: error,
        },
      );
    }
    throw new Error(`cron store guard failed for ${path}`, { cause: error });
  } finally {
    database?.close();
  }
}
