// Issue #484 (rodada 2, veredito da PR #497): `PreviewCacheFacade.put()` IS
// reachable during a preview — a `parallel` node whose `branches` resolves
// to `[]` calls `cache.put(...)` UNCONDITIONALLY (`engine.ts`'s
// `runParallel`, `[].every(nonEmpty)` is vacuously `true`) without spawning
// a single leaf, dry or real. Split out of
// `tests/workflow-cache-preview.test.ts` (issue #484 amendment,
// 2026-09-13) — that file is at the 800-line cap.
//
// `par` (`branches: []`) depends on `bad`, a pinned agent node whose REAL
// launch fails with `auth_failed` (a route fault) — the real run pauses
// there, so `par` is genuinely never reached, never cached, in the real
// launch either. During the PREVIEW, `DryRuntime.collect` reports a plain
// (non-route-fault) failure for `bad` — `nonCompleteFirstCollectResult`
// only pauses on a quota/route-fault kind (module comment,
// `cache-preview.ts`), so the preview's own run keeps going past `bad` and
// reaches `par`: a genuine cache MISS, `runParallel` runs for real, and
// `put()` is exactly the call under test.
//
// Two independent barriers stop this from landing a row in
// `workflow_node_cache`, so a row-count oracle alone can't tell them apart:
// (1) `PreviewCacheFacade.put()`'s own `return false` (this is P6's
// target — `scripts/mutations/supervision-mutants.ts`), and (2)
// `previewResume`'s `dummyOwnership` (`fence: -1`) makes the guarded
// `SqliteWorkflowCache` it wraps refuse ANY write via
// `workflow-repository.ts`'s `ownershipGuard`, mutated or not. So this
// oracle ALSO counts attempts at `WorkflowRepository.putCacheCellWithCost`
// (via a counting subclass injected through the same `deps.repository` seam
// `previewResume` already takes) — that call only happens if the facade's
// `put()` delegates through, independent of whether the guarded `INSERT`
// then succeeds. The row-count assertion stays too: it pins barrier (2) on
// its own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import type { PreviewDeps } from "../src/workflow/cache-preview.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** Same shape as `tests/workflow-cache-preview.test.ts`'s own
 * `routingRuntime` — fails with `auth_failed` (a route fault) while the
 * request's `provider` is `badProvider`, so the REAL launch pauses there. */
function routingRuntime(badProvider: string): ChildRuntime {
  let seq = 0;
  const providerById = new Map<string, string | null>();
  return {
    spawn: (request: ChildSpawnRequest): string => {
      seq += 1;
      const id = `leaf-${String(seq)}`;
      providerById.set(id, request.provider ?? null);
      return id;
    },
    collect: (id: string, _options: ChildCollectOptions): ChildResult => {
      const provider = providerById.get(id) ?? null;
      if (provider === badProvider) {
        return { status: "failed", output: "boom", errorKind: "auth_failed", provider };
      }
      return { status: "complete", output: { ok: true }, usage: USAGE, provider };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
  };
}

/** Counts attempts at the ONE write path `SqliteWorkflowCache.put` uses
 * (`putCacheCellWithCost`) — observable even when `previewResume`'s
 * `dummyOwnership` (`fence: -1`) makes `ownershipGuard` refuse the guarded
 * `INSERT` itself, so `cellWriteAttempts` catches a delegating `put()`
 * (P6's mutation) that the row count alone cannot. */
class CountingRepository extends WorkflowRepository {
  cellWriteAttempts = 0;

  override putCacheCellWithCost(
    ...args: Parameters<WorkflowRepository["putCacheCellWithCost"]>
  ): ReturnType<WorkflowRepository["putCacheCellWithCost"]> {
    this.cellWriteAttempts += 1;
    return super.putCacheCellWithCost(...args);
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-cache-preview-writes-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new CountingRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({
    runtime: routingRuntime("bad-provider"),
    auditTrail: trail,
    store,
  });
  return {
    service,
    database: connection.database,
    repository,
    preview: async (deps: Omit<PreviewDeps, "database" | "repository" | "locks">) => {
      const { previewResume } = await import("../src/workflow/cache-preview.js");
      return previewResume({ database: connection.database, repository, locks, ...deps });
    },
    close: (): void => {
      connection.close();
    },
  };
}

function rowCount(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number | bigint;
  };
  return Number(row.n);
}

describe("previewResume — PreviewCacheFacade.put() (#484 rodada 2, veredito PR #497)", () => {
  it("a parallel node with empty branches writes nothing to workflow_node_cache during preview", async () => {
    const { service, database, repository, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "par-empty-branches" },
        nodes: [
          { id: "bad", type: "agent", prompt: "pinned", provider: "bad-provider" },
          { id: "par", type: "parallel", branches: [], depends_on: ["bad"] },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = rowCount(database, "workflow_node_cache");
      const attemptsBefore = repository.cellWriteAttempts;
      expect(before).toBe(0); // `bad` failed, `par` never ran — nothing cached yet

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      // `par` never spawns (no branches) and never hits (never cached), so
      // it classifies `unknown` — a documented gap, not this test's point.
      // What matters: `runParallel` still RAN for it (a genuine cache
      // miss), reaching `cache.put([])`.
      expect(result.nodes.find((entry) => entry.node_id === "par")?.outcome).toBe("unknown");

      // Barrier (1): the facade's `put()` never calls through to the real
      // repository at all — this is what P6 mutates.
      expect(repository.cellWriteAttempts).toBe(attemptsBefore);
      // Barrier (2), independent of (1): even a guarded attempt would be
      // refused by `ownershipGuard` (`fence: -1`), so no row lands either
      // way — pinned here so a future change to the fence doesn't silently
      // widen what this oracle can no longer tell apart.
      expect(rowCount(database, "workflow_node_cache")).toBe(before);
    } finally {
      close();
    }
  });
});

// Issue #502 (non_blocking 4, PR #497): `estimated_tokens_to_repay`/
// `estimate_basis` (`cache-preview.ts:116-117`, computed at `:388-390`) had
// no mutant in the `supervision` slice at all — P1-P6 above cover other
// `PreviewResult` fields, never this pair. `workflow_node_cost` is planted
// directly (same "insert the row the real write path would eventually
// produce" posture `tests/state-audit-repository.test.ts` uses for
// `fieldMarkerRows`) rather than driven through a full costed run — the
// average's SOURCE rows are not this test's point, only that `query()`'s
// arithmetic over them is exact.
describe("previewResume — estimated_tokens_to_repay / estimate_basis (#502)", () => {
  it("averages workflow_node_cost across the run and rounds leavesToSpawn * average exactly", async () => {
    const { service, database, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "estimate-repay" },
        nodes: [{ id: "bad", type: "agent", prompt: "pinned", provider: "bad-provider" }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true); // pauses on bad's auth_failed — never costed

      // Two costed cells from some OTHER prior work on this run: average =
      // (10+10 + 20+21) / 2 = 30.5 — a fractional average makes the
      // rounding in `estimated_tokens_to_repay` observable (a dropped
      // `Math.round` would leave `30.5`, not `31`).
      database
        .prepare(
          `INSERT INTO workflow_node_cost (run_id, content_hash, tokens_in, tokens_out)
           VALUES (?, ?, ?, ?)`,
        )
        .run(started.run_id, "hash-1", 10, 10);
      database
        .prepare(
          `INSERT INTO workflow_node_cost (run_id, content_hash, tokens_in, tokens_out)
           VALUES (?, ?, ?, ?)`,
        )
        .run(started.run_id, "hash-2", 20, 21);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      // `bad` never completed durably — the preview's dry run re-spawns it,
      // exactly the one leaf this run has left to pay for.
      expect(result.leaves_to_spawn).toBe(1);
      expect(result.estimated_tokens_to_repay).toBe(31);
      expect(result.estimate_basis).toBe("measured_average");
    } finally {
      close();
    }
  });
});
