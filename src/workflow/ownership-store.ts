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
 * Builds the OwnershipStore a production composition root (chat, dashboard)
 * hands to WorkflowService, over a connection.database THEY already opened —
 * this function never opens a second connection. `ttl` is always
 * RUN_LEASE_TTL; `holder` defaults to a fresh productionHolder() computed
 * once and reused for every lease this store takes, so a process presents one
 * identity across the run of its runs.
 */
export function productionOwnershipStore(
  database: Database.Database,
  options: {
    readonly holder?: string;
    /** Injectable clock, seconds since epoch; defaults to the wall clock. */
    readonly now?: () => number;
    // Issue #135: not yet threaded to WorkflowRepository/LockRepository —
    // the type exists so the test(red) commit compiles against the
    // assertion it adds; the next commit wires it through.
    readonly warning?: (warning: StateWarning) => void;
  } = {},
): OwnershipStore {
  const holder = options.holder ?? productionHolder();
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  return Object.freeze({
    repository: new WorkflowRepository(database),
    locks: new LockRepository(database),
    holder,
    ttl: RUN_LEASE_TTL,
    ownershipOf: (): Ownership => ({ fence: 0, holder, now: now() }),
    database,
  });
}
