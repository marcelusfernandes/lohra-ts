// Issue #501 (follow-up of #485, PR #495 non_blocking 3 and 4): a path a
// PRIOR stretch already flagged as colliding gets flagged AGAIN if a leaf in
// a LATER stretch writes it too — `recordCrossStretchArtifactCollisions`'s
// own `artifactCollisionPaths` dedup Set is fresh per `RunResult`, so it has
// no memory of what an earlier stretch's OWN persisted `artifact_faults`
// already reported. `service.ts`'s terminal fold (which unshifts a prior
// stretch's `artifacts`/`artifact_faults` into the live view) then carries
// BOTH the old and the new advisory forward, with different `node_id`s —
// "reported once per path" (the `workflow_status` tool description) stops
// being true across a resume.
//
// Two scenarios, two harnesses:
//  - "different node in stretch 2" needs the STRETCH-1 writer to be
//    genuinely CACHED on resume (never re-executes, never re-flags on its
//    own) so the ONLY new write in stretch 2 comes from a brand-new node.
//    The shared `harness()` in `tests/workflow-artifacts.test.ts` claims a
//    hardcoded `fence: 0` for its `SqliteWorkflowCache`, which never matches
//    the REAL fence `acquireRunLease` assigns (1 on the very first
//    acquisition) — every `cache.put` there is refused, which is why #485's
//    own test 4 needed the SAME node to RE-RUN (cache miss) to reproduce a
//    duplicate at all. This file's `fenceCorrectHarness` below tracks the
//    run's REAL fence (`locks.runFenceOf`) instead, so a cache PUT during
//    stretch 1 actually lands and a resume's `cacheGet` is a genuine hit.
//  - "same path re-flagged, different resume" reuses the EXISTING broken
//    `harness()`/`collidingParallelCheckpointSpec()` unchanged — caching
//    is irrelevant there: stretch 1's own two branches already collide
//    WITHIN that stretch (no cache involved at all), and stretch 2 rewrites
//    the same path again, cache-miss or not.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A durable-shaped runtime: every leaf writes the SAME `path` — molded on
 * `artifactRuntimeStub` in `tests/workflow-artifacts.test.ts` (#463/#485). */
function artifactRuntimeStub(path: string): ChildRuntime {
  let seq = 0;
  return {
    spawn(): string {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect(): ChildResult {
      return {
        status: "complete",
        output: "ok",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        artifacts: [{ path, bytes: 3 }],
      };
    },
    steer(): void {},
    cancel(): void {},
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    },
  };
}

/** A `parallel` node whose branches BOTH write the SAME path — molded on
 * `collidingParallelCheckpointSpec` (tests/workflow-artifacts.test.ts, #485). */
function collidingParallelCheckpointSpec(): Record<string, unknown> {
  return {
    meta: { name: "collide-cp" },
    nodes: [
      { id: "p", type: "parallel", branches: ["x", "y"] },
      { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
    ],
  };
}

/** Molded on `harness()` (tests/workflow-artifacts.test.ts) — a hardcoded
 * `fence: 0` ownership never matching the real fence, so the cache never
 * lands. Kept unchanged (byte-for-byte behaviour) on purpose: the "already
 * flagged" test below needs a stretch-1 collision it does NOT need a valid
 * fence to reproduce. */
function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-artifacts-dedup-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const cacheFactory = (runId: string): SqliteWorkflowCache =>
    new SqliteWorkflowCache(connection.database, runId, () => ({
      fence: ownership.fence,
      holder: ownership.holder,
      now: ownership.now,
    }));
  const service = new WorkflowService({ runtime, store, cacheFactory });
  return {
    service,
    store,
    cacheFactory,
    close: () => {
      connection.close();
    },
  };
}

/** UNLIKE `harness()` above, the cache's ownership claims the run's REAL
 * fence (`locks.runFenceOf`) at every read/write — so a `cache.put` during
 * stretch 1 actually satisfies `ownershipGuard` (workflow-repository.ts) and
 * lands, and a stretch-2 `cache.get` for the SAME cell is a genuine hit
 * (reads are unfenced regardless, but nothing to find without this). */
function fenceCorrectHarness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-artifacts-dedup-fenced-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const store = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
    database: connection.database,
  };
  const cacheFactory = (runId: string): SqliteWorkflowCache =>
    new SqliteWorkflowCache(connection.database, runId, () => ({
      fence: locks.runFenceOf(runId) ?? -1,
      holder: "test",
      now: 1000,
    }));
  const service = new WorkflowService({ runtime, store, cacheFactory });
  return {
    service,
    store,
    cacheFactory,
    close: () => {
      connection.close();
    },
  };
}

/** Stretch 1: parallel node "a" (branches x, y) both write the shared path —
 * ONE in-stretch collision, attributed to "a". Stretch 2, after the "a" cell
 * hits cache (never re-executes, never re-writes), a brand-new node "b"
 * writes the SAME path — a genuinely new, different writer. */
function crossStretchDedupSpec(): Record<string, unknown> {
  return {
    meta: { name: "cross-stretch-dedup" },
    nodes: [
      { id: "a", type: "parallel", branches: ["x", "y"] },
      { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
      { id: "b", type: "agent", prompt: "x" },
    ],
  };
}

describe("write-file manifest — one advisory per path across stretches (#501)", () => {
  it("a different node in stretch 2 writing a path stretch 1's cached node already owned reports exactly one advisory", async () => {
    const { service, store, cacheFactory, close } = fenceCorrectHarness(
      artifactRuntimeStub("/shared.txt"),
    );
    const started = service.start(crossStretchDedupSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    // Both "a" branches landed, nothing from "b" yet (it sits after cp1).
    expect(paused.artifacts as unknown[]).toHaveLength(2);
    expect(paused.faults as string[]).toContain(
      "a: artifact path written by 2 leaves: /shared.txt",
    );

    const resumeService = new WorkflowService({
      runtime: artifactRuntimeStub("/shared.txt"),
      store,
      cacheFactory,
    });
    const resumed = (await resumeService.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(resumed.status).toBe("complete");
    // "a" hit cache (fence-valid replay): a re-run would add 2 MORE writes
    // (4 total from "a") plus "b"'s — 5. Exactly 3 proves "a" never reran.
    expect(resumed.artifacts as unknown[]).toHaveLength(3);
    // The bug: stretch 1's own advisory ("a: ...") AND a second one for the
    // SAME path from stretch 2's cross-stretch check ("b: ...") — one path,
    // two advisories. Fixed: only the earliest survives.
    expect(resumed.faults).toEqual(["a: artifact path written by 2 leaves: /shared.txt"]);
    close();
  });

  it("a path stretch 1 already flagged, written again in stretch 2, still reports exactly one advisory", async () => {
    const { service, store, cacheFactory, close } = harness(artifactRuntimeStub("/shared.txt"));
    const started = service.start(collidingParallelCheckpointSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect(paused.faults as string[]).toContain(
      "p: artifact path written by 2 leaves: /shared.txt",
    );

    // The SAME path gets written again in stretch 2 (this harness never
    // caches anything — "p"'s own branches re-run, re-detect their OWN
    // in-stretch collision, and `recordCrossStretchArtifactCollisions`
    // finds nothing NEW to add on top of that — the duplicate comes purely
    // from folding stretch 1's persisted advisory back in unchanged).
    const resumeService = new WorkflowService({
      runtime: artifactRuntimeStub("/shared.txt"),
      store,
      cacheFactory,
    });
    const resumed = (await resumeService.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(resumed.status).toBe("complete");
    expect(resumed.faults).toEqual(["p: artifact path written by 2 leaves: /shared.txt"]);
    close();
  });
});
