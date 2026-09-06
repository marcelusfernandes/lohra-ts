import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type Database from "better-sqlite3";

import { LockRepository } from "../state/locks.js";
import type { StateWarning } from "../state/locks.js";
import type { Ownership } from "../state/workflow-repository.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import { RUN_LEASE_TTL, type OwnershipStore } from "./service.js";

/**
 * A holder identity distinct per PROCESS (and, within a process, per call):
 * `<hostname>:<pid>:<8 hex chars>`. Two calls — same process or not — never
 * collide, because the random suffix is drawn fresh each time. The format is
 * stable (three `:`-joined, non-empty segments); the suffix is opaque.
 */
export function productionHolder(): string {
  return `${hostname()}:${String(process.pid)}:${randomUUID().slice(0, 8)}`;
}

/**
 * The sink a production composition root (chat, dashboard, the read-only
 * `workflow` command) wires to a `StateWarning`-emitting repository so a
 * STALE_FENCE_WRITE refusal — a concurrent resume, a late heartbeat — never
 * disappears in silence (issue #135). Default writer is `console.warn`
 * (stderr), matching the "workflow: …" prefix WorkflowService.warn already
 * uses for its own messages; a caller with its own stderr boundary (e.g. the
 * `workflow` command's `options.stderr`) passes its own `write`.
 */
export function productionWarningSink(
  write: (message: string) => void = (message) => {
    console.warn(message);
  },
): (warning: StateWarning) => void {
  return (warning): void => {
    write(`workflow: ${warning.cause} run=${warning.runId} fence=${String(warning.fence)}`);
  };
}

/**
 * Builds the OwnershipStore a production composition root (chat, dashboard)
 * hands to WorkflowService, over a connection.database THEY already opened —
 * this function never opens a second connection. `ttl` is always
 * RUN_LEASE_TTL; `holder` defaults to a fresh productionHolder() computed
 * once and reused for every lease this store takes, so a process presents one
 * identity across the run of its runs. `warning` defaults to
 * `productionWarningSink()` and is threaded to BOTH the WorkflowRepository
 * and the LockRepository this store builds — one sink, one place a refusal
 * from either repository surfaces (issue #135).
 */
export function productionOwnershipStore(
  database: Database.Database,
  options: {
    readonly holder?: string;
    /** Injectable clock, seconds since epoch; defaults to the wall clock. */
    readonly now?: () => number;
    readonly warning?: (warning: StateWarning) => void;
  } = {},
): OwnershipStore {
  const holder = options.holder ?? productionHolder();
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const warning = options.warning ?? productionWarningSink();
  return Object.freeze({
    repository: new WorkflowRepository(database, warning),
    locks: new LockRepository(database, warning),
    holder,
    ttl: RUN_LEASE_TTL,
    ownershipOf: (): Ownership => ({ fence: 0, holder, now: now() }),
    database,
  });
}
