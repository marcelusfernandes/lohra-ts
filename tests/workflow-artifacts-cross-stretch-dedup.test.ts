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
import type { ChildResult, ChildRuntime, WorkflowLoader } from "../src/workflow/index.js";

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
function fenceCorrectHarness(runtime: ChildRuntime, loader?: WorkflowLoader) {
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
  const service = new WorkflowService({
    runtime,
    store,
    cacheFactory,
    ...(loader === undefined ? {} : { loader }),
  });
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

// Issue #512 (follow-up of #501, veredito non_blocking 1 da PR #508):
// `foldArtifactFaults` (accounting.ts, called from service.ts's terminal
// fold) dedupes the LIVE view, but `pausePayloadOf` (route-override.ts)
// used to build the PERSISTED `pause_payload_json` by plainly concatenating
// `priorView.artifact_faults` with `result.artifactFaults` — never through
// `dedupeArtifactFaultsByPath`. Two resumes, each with a brand-new node
// racing the SAME path a cached earlier node already owns (the
// `fenceCorrectHarness` scenario above, repeated twice), used to leave TWO
// duplicate advisories sitting in the durable row — a genuinely cold read
// (`durableFromRow`/`durableRollup`, never the in-process `resultView`)
// exposed both. Fixed: `pausePayloadOf` dedupes before persisting, so a
// cold read agrees with the live one no matter how many resumes came
// before it.
function twoResumesSharedPathSpec(): Record<string, unknown> {
  return {
    meta: { name: "two-resumes-shared-path" },
    nodes: [
      { id: "a", type: "agent", prompt: "alpha" },
      { id: "cp1", type: "checkpoint", prompt: "first?", default: "yes" },
      { id: "b", type: "agent", prompt: "beta" },
      { id: "cp2", type: "checkpoint", prompt: "second?", default: "yes" },
      { id: "c", type: "agent", prompt: "gamma" },
    ],
  };
}

describe("write-file manifest — dedup applies BEFORE persisting, not just on live read (#512)", () => {
  it("two resumes still leave durableRollup.artifact_faults, read cold, with exactly one advisory for the shared path", async () => {
    const { service, store, cacheFactory, close } = fenceCorrectHarness(
      artifactRuntimeStub("/shared.txt"),
    );
    const started = service.start(twoResumesSharedPathSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    // Only "a" has written so far — no collision yet.
    expect(
      (paused.faults as string[]).some((fault) => fault.includes("artifact path written")),
    ).toBe(false);

    const resume1Service = new WorkflowService({
      runtime: artifactRuntimeStub("/shared.txt"),
      store,
      cacheFactory,
    });
    const pausedAgain = (await resume1Service.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(pausedAgain.status).toBe("paused");
    // "a" hit cache (fence-valid replay, never rewrote), "b" is the new
    // writer racing "a"'s own path — the FIRST cross-stretch advisory,
    // attributed to "b" (`cp2` itself also contributes its own "waiting for
    // answer" fault — irrelevant to this issue, filtered out below).
    expect(
      (pausedAgain.faults as string[]).filter((fault) => fault.includes("artifact path written")),
    ).toEqual(["b: artifact path written by 2 leaves: /shared.txt"]);

    const resume2Service = new WorkflowService({
      runtime: artifactRuntimeStub("/shared.txt"),
      store,
      cacheFactory,
    });
    const completed = (await resume2Service.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp2: "yes" } },
    )) as Record<string, unknown>;
    expect(completed.status).toBe("complete");
    // "a" and "b" both cached, "c" is a SECOND new writer racing the same
    // path — its own fresh `RunResult` has no memory of "b"'s already-
    // persisted advisory, so the live fold (#501) still keeps only the
    // FIRST ("b"'s) advisory here too.
    expect(completed.faults).toEqual(["b: artifact path written by 2 leaves: /shared.txt"]);

    // A genuinely cross-process, not-live read — durableFromRow/
    // durableRollup, never the in-process resultView (#501's own
    // cold-service pattern, molded on #246 AC3). This is the field the
    // BASE (pre-#512) duplicates: `pausePayloadOf` persisted "b"'s AND
    // "c"'s advisory side by side, both for "/shared.txt".
    const coldService = new WorkflowService({
      runtime: artifactRuntimeStub("/unused.txt"),
      store,
      cacheFactory,
    });
    const dormantView = (await coldService.status(started.run_id)) as Record<string, unknown>;
    expect(dormantView.artifact_faults).toEqual([
      "b: artifact path written by 2 leaves: /shared.txt",
    ]);
    close();
  });
});

// Issue #539 (follow-up of #512, veredito non_blocking 1 da PR #538):
// `foldNestedCounters` writes a nested artifact's `node_id` UNSPACED
// (`sub[${reference}]:${node_id}`, pinned by `tests/workflow-artifacts
// .test.ts:331`), but every fault-string scope prefix elsewhere in this
// module is SPACED (`sub[${reference}]: `). `recordCrossStretchArtifact
// Collisions` used to cunhar its fault straight from that unspaced
// `node_id` — the base `NESTED_SCOPE_PREFIX_RE` (space-only) then read the
// unspaced chain as scope `""`, the SAME empty scope a genuinely unscoped
// top-level fault gets. Both scenarios below need `fenceCorrectHarness`,
// never the hardcoded-`fence: 0` `harness()`: a genuinely re-executed
// top-level writer would re-flag its OWN in-stretch collision BEFORE the
// cross-stretch check runs, populating `result.artifactCollisionPaths` and
// silently suppressing the very fault these tests exist to catch.
function nestedInternalCollisionThenCrossStretchSpec(): Record<string, unknown> {
  return {
    meta: { name: "nested-internal-collision-cross-stretch" },
    nodes: [
      { id: "sub1", type: "workflow", ref: "child" },
      { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
      { id: "sub2", type: "workflow", ref: "child" },
    ],
  };
}

/** Both branches of the inner `parallel` node write the SAME path — an
 * in-stretch collision entirely WITHIN whichever `type: "workflow"` node
 * loads this as its child. */
function childCollidingSpec(): Record<string, unknown> {
  return {
    meta: { name: "child" },
    nodes: [{ id: "p", type: "parallel", branches: ["x", "y"] }],
  };
}

function topLevelCollisionThenNestedCrossStretchSpec(): Record<string, unknown> {
  return {
    meta: { name: "top-level-collision-nested-cross-stretch" },
    nodes: [
      { id: "p", type: "parallel", branches: ["x", "y"] },
      { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
      { id: "sub", type: "workflow", ref: "innerSingle" },
    ],
  };
}

/** A single leaf, no internal collision of its own — the ONLY fault this
 * child can ever contribute is a cross-stretch one, attributed to ITS OWN
 * (unspaced) `node_id`. */
function childSingleLeafSpec(): Record<string, unknown> {
  return {
    meta: { name: "innerSingle" },
    nodes: [{ id: "leaf", type: "agent", prompt: "x" }],
  };
}

describe("write-file manifest — nested sub[ref] scope survives cross-stretch dedup (#539)", () => {
  it("a nested sub-workflow's own internal collision and a LATER cross-stretch check on the SAME reference collapse to one advisory", async () => {
    const { service, store, cacheFactory, close } = fenceCorrectHarness(
      artifactRuntimeStub("/nested.txt"),
      () => childCollidingSpec(),
    );
    const started = service.start(nestedInternalCollisionThenCrossStretchSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect(
      (paused.faults as string[]).filter((fault) => fault.includes("artifact path written")),
    ).toEqual(["sub[child]: p: artifact path written by 2 leaves: /nested.txt"]);

    const resumeService = new WorkflowService({
      runtime: artifactRuntimeStub("/nested.txt"),
      store,
      cacheFactory,
      loader: () => childCollidingSpec(),
    });
    const resumed = (await resumeService.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(resumed.status).toBe("complete");
    // sub1's 2 branches (stretch 1) + sub2's 2 branches (stretch 2) — sub1's
    // OWN rerun on resume hits cache (fence-valid replay of its inner "p"
    // node) and contributes NOTHING new. 6 here would mean sub1 genuinely
    // reran and wrote again.
    expect(resumed.artifacts as unknown[]).toHaveLength(4);
    expect(resumed.faults).toEqual([
      "sub[child]: p: artifact path written by 2 leaves: /nested.txt",
    ]);
    close();
  });

  it("a cross-stretch collision from a NESTED sub-workflow never collapses with a top-level collision on the same path", async () => {
    const { service, store, cacheFactory, close } = fenceCorrectHarness(
      artifactRuntimeStub("/shared.txt"),
      () => childSingleLeafSpec(),
    );
    const started = service.start(topLevelCollisionThenNestedCrossStretchSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect(
      (paused.faults as string[]).filter((fault) => fault.includes("artifact path written")),
    ).toEqual(["p: artifact path written by 2 leaves: /shared.txt"]);

    const resumeService = new WorkflowService({
      runtime: artifactRuntimeStub("/shared.txt"),
      store,
      cacheFactory,
      loader: () => childSingleLeafSpec(),
    });
    const resumed = (await resumeService.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(resumed.status).toBe("complete");
    // "p"'s 2 branches (stretch 1, cached on resume, contributes nothing
    // new) + "sub"'s single leaf (stretch 2) — 3 confirms "p" never reran.
    expect(resumed.artifacts as unknown[]).toHaveLength(3);
    expect(resumed.faults).toEqual([
      "p: artifact path written by 2 leaves: /shared.txt",
      "sub[innerSingle]: leaf: artifact path written by 2 leaves: /shared.txt",
    ]);
    close();
  });
});
