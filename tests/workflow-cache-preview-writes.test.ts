// Issue #484 (rodada 2, veredito da PR #497): `PreviewCacheFacade.put()` IS
// reachable during a preview — a `parallel` node whose `branches` resolves
// to `[]` calls `cache.put(...)` UNCONDITIONALLY (`engine.ts`'s
// `runParallel`, `[].every(nonEmpty)` is vacuously `true`) without spawning
// a single leaf, dry or real. `put`'s own `return false` is the only thing
// stopping that write from reaching the real database — this is the
// oracle P6 (`scripts/mutations/supervision-mutants.ts`) anchors on. Split
// out of `tests/workflow-cache-preview.test.ts` (issue #484 amendment,
// 2026-09-13) — that file is at the 800-line cap.
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
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";
import type { PreviewDeps } from "../src/workflow/cache-preview.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** This suite's only spec never needs a leaf: `checkpoint` pauses without
 * spawning, and a `parallel` with `branches: []` has none to spawn. */
function neverSpawnRuntime(): ChildRuntime {
  return {
    spawn: (): never => {
      throw new Error("must not spawn — this spec has no leaf work");
    },
    collect: (): ChildResult => ({ status: "failed", output: null }),
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-cache-preview-writes-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
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
  const service = new WorkflowService({ runtime: neverSpawnRuntime(), auditTrail: trail, store });
  return {
    service,
    database: connection.database,
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

function snapshot(database: Database.Database, runId: string) {
  return {
    node_cache: rowCount(database, "workflow_node_cache"),
    row: database.prepare("SELECT * FROM workflow_run_state WHERE run_id = ?").get(runId),
  };
}

describe("previewResume — PreviewCacheFacade.put() (#484 rodada 2, veredito PR #497)", () => {
  it("a parallel node with empty branches writes nothing to workflow_node_cache during preview", async () => {
    const { service, database, preview, close } = harness();
    try {
      // `par` depends on `gate` (an unanswered checkpoint) so the run pauses
      // BEFORE `par` ever executes in the real launch — `par`'s cell is
      // genuinely never written there either, isolating this assertion to
      // what the PREVIEW's own `put()` does (or must not do).
      const spec = {
        meta: { name: "par-empty-branches" },
        nodes: [
          { id: "gate", type: "checkpoint", prompt: "go?" },
          { id: "par", type: "parallel", branches: [], depends_on: ["gate"] },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = snapshot(database, started.run_id);
      expect(before.node_cache).toBe(0);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);

      const after = snapshot(database, started.run_id);
      expect(after).toEqual(before);
    } finally {
      close();
    }
  });
});
