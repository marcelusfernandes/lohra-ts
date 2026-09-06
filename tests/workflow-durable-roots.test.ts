import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationCore, type ChildRunner } from "../src/orchestration/core.js";
import { orchestrationMutants } from "../scripts/mutations/orchestration.js";
import type { StateWarning } from "../src/state/index.js";
import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import {
  OrchestrationChildRuntime,
  productionHolder,
  productionOwnershipStore,
  productionWarningSink,
  RUN_LEASE_TTL,
  SqliteWorkflowCache,
  WorkflowService,
} from "../src/workflow/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spec(): Record<string, unknown> {
  return {
    meta: { name: "durable" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

function tmpDatabase() {
  const root = mkdtempSync(join(tmpdir(), "lohra-t101-roots-"));
  roots.push(root);
  return { root, ...openStateDatabase(join(root, "state.db")) };
}

function runStateCount(database: import("better-sqlite3").Database): number {
  const row = database.prepare("SELECT count(*) AS n FROM workflow_run_state").get() as {
    n: number | bigint;
  };
  return Number(row.n);
}

function runSpendCount(database: import("better-sqlite3").Database): number {
  const row = database.prepare("SELECT count(*) AS n FROM workflow_run_spend").get() as {
    n: number | bigint;
  };
  return Number(row.n);
}

function coreWithChild(runChild: ChildRunner): OrchestrationCore {
  return new OrchestrationCore({
    runChild,
    idSource: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `leaf-${String(n)}`;
      };
    })(),
    maxSubsessions: 100,
    maxParallel: 10,
    buildSubagentPrompt: () => "SYS",
  });
}

describe("productionHolder (AC: holder distinct per call, stable format)", () => {
  it("produces a distinct holder on each call", () => {
    const a = productionHolder();
    const b = productionHolder();
    expect(a).not.toBe(b);
  });

  it("has the stable shape <hostname>:<pid>:<8 hex chars>", () => {
    const holder = productionHolder();
    const parts = holder.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]).toBe(String(process.pid));
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("productionOwnershipStore (AC: built over the caller's own connection, ttl = RUN_LEASE_TTL)", () => {
  it("never opens a second connection — repository/locks/database share the one it was given", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database);
      expect(store.database).toBe(connection.database);
      expect(store.ttl).toBe(RUN_LEASE_TTL);
      expect(store.repository).toBeInstanceOf(WorkflowRepository);
      expect(store.locks).toBeInstanceOf(LockRepository);
    } finally {
      connection.close();
    }
  });

  it("defaults to a fresh productionHolder, reused across ownershipOf() calls", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database);
      expect(store.ownershipOf().holder).toBe(store.holder);
      expect(store.ownershipOf().holder).toBe(store.holder); // stable across calls
    } finally {
      connection.close();
    }
  });

  it("accepts an injected clock for ownershipOf().now", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database, { now: () => 1234 });
      expect(store.ownershipOf().now).toBe(1234);
    } finally {
      connection.close();
    }
  });
});

// Issue #135 (follow-up of #125/#101, PR #133 reviewer finding 4): the
// three production construction sites built `WorkflowRepository` with its
// default no-op warning sink, so a STALE_FENCE_WRITE refusal — a
// concurrent resume or a late heartbeat — vanished in silence. These two
// tests fix that `productionOwnershipStore` accepts and threads a `warning`
// sink to BOTH the repository and the locks it builds.
describe("productionOwnershipStore (issue #135): threads the warning sink", () => {
  it("passes the sink to the WorkflowRepository it builds — a refused owned write reaches it", () => {
    const connection = tmpDatabase();
    try {
      const warnings: StateWarning[] = [];
      const store = productionOwnershipStore(connection.database, {
        warning: (warning) => warnings.push(warning),
      });
      const runId = "run-repo-sink";
      // No lease was ever acquired for this run — any fenced write presents
      // a fence that cannot match, the exact case `refuse()` guards.
      const ok = store.repository.putRunState(runId, {
        name: null,
        owner: null,
        status: "running",
        pauseReason: null,
        pausePayloadJson: null,
        specJson: null,
        argsJson: null,
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence: 1,
        holder: store.holder,
        now: 1000,
      });
      expect(ok).toBe(false);
      expect(warnings).toEqual([{ cause: "STALE_FENCE_WRITE", runId, fence: 1 }]);
    } finally {
      connection.close();
    }
  });

  it("passes the SAME sink to the LockRepository it builds — a stale probe write reaches it too (coherence: tryWriteProbeRunState is exercised only by tests, never by production code)", () => {
    const connection = tmpDatabase();
    try {
      const warnings: StateWarning[] = [];
      const store = productionOwnershipStore(connection.database, {
        holder: "holder-a",
        now: () => 1000,
        warning: (warning) => warnings.push(warning),
      });
      const runId = "run-lock-sink";
      const first = store.locks.acquireRunLease(runId, store.holder, 1000, RUN_LEASE_TTL);
      if (first === null) throw new Error("expected lease token");
      // Release before re-acquiring: `workflow_run_locks.run_id` is a
      // primary key, so a second acquisition while the first is still live
      // would hit a UNIQUE constraint, not the fence check this test wants.
      expect(store.locks.releaseRunLease(runId, store.holder)).toBe(true);
      const second = store.locks.acquireRunLease(runId, store.holder, 1000, RUN_LEASE_TTL);
      expect(second).not.toBeNull();
      // "second" bumped the fence past "first" — a probe write presenting
      // the now-stale "first" token is refused and warns.
      const ok = store.locks.tryWriteProbeRunState(runId, store.holder, "running", 1000, first);
      expect(ok).toBe(false);
      expect(warnings).toEqual([{ cause: "STALE_FENCE_WRITE", runId, fence: first }]);
    } finally {
      connection.close();
    }
  });

  // The third production site named in issue #135's Contexto:
  // sqlite-cache.ts:26 falls back to `new WorkflowRepository(database)`
  // ONLY when the caller does not supply `repository` (service.ts's real
  // composition always does, via `store.repository` — already covered by
  // the two tests above). This is the "or an option" half.
  it("SqliteWorkflowCache's own `warning` option reaches the WorkflowRepository it builds when no `repository` is supplied", () => {
    const connection = tmpDatabase();
    try {
      const warnings: StateWarning[] = [];
      const runId = "run-cache-sink";
      const cache = new SqliteWorkflowCache(
        connection.database,
        runId,
        () => ({ fence: 1, holder: "h", now: 1000 }),
        { warning: (warning) => warnings.push(warning) },
      );
      // No lease was ever acquired for this run — the presented fence (1)
      // cannot match, the exact case `refuse()` guards.
      const ok = cache.put(runId, "hash", "node", { x: 1 }, null);
      expect(ok).toBe(false);
      expect(warnings).toEqual([{ cause: "STALE_FENCE_WRITE", runId, fence: 1 }]);
    } finally {
      connection.close();
    }
  });
});

// --- Formerly a blocker finding on issue #101, now the inverse. -----------
//
// Until #107 (PR #110), `OrchestrationChildRuntime` had no
// `installLeafSandbox`, so `WorkflowService.start()`'s durable path (taken
// whenever `store` is set) refused every launch with `LEAF_SANDBOX_UNAVAILABLE`
// before writing a single row — wiring `store` into chat.ts/dashboard.ts
// would have REGRESSED `run_workflow` to always-refuse. #107 gave
// `OrchestrationChildRuntime` a real `installLeafSandbox` (keyed by runId,
// disposed by fence), so this test now fixes the opposite: the exact
// composition chat.ts/dashboard.ts use — `productionOwnershipStore` (#101)
// over a real `state.db` + `OrchestrationChildRuntime` over a real
// `OrchestrationCore` — launches without refusing and persists the launch
// line and the spend seed synchronously, before the leaf's own turn ever
// runs (`tests/workflow-orchestration-runtime.test.ts` covers the sandbox
// enforcement itself in depth; this test is scoped to "does #101's store
// wiring actually reach a working durable launch").
describe("OrchestrationChildRuntime + productionOwnershipStore: durable launch works (issue #101, unblocked by #107)", () => {
  it("a durable launch persists workflow_run_state and workflow_run_spend without refusing", async () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database, { now: () => 1000 });
      const runChild: ChildRunner = () =>
        Promise.resolve({
          status: "complete",
          output: "leaf done",
          tokensIn: 1,
          tokensOut: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          provider: "test",
          model: "test-model",
          forcedFallback: false,
          errorKind: null,
          retryAfter: null,
        });
      const service = new WorkflowService({
        runtime: new OrchestrationChildRuntime(coreWithChild(runChild)),
        store,
        homeRoot: connection.root,
        timerFactory: () => ({ cancel: () => undefined }),
      });
      const started = service.start(spec(), {});
      expect("error" in started).toBe(false);
      if ("error" in started) throw new Error(started.error);
      expect(runStateCount(connection.database)).toBeGreaterThan(0);
      expect(runSpendCount(connection.database)).toBeGreaterThan(0);
      await service.status(started.run_id, true);
    } finally {
      connection.close();
    }
  });
});

// Issue #143 — the `qa` follow-up to PR #139 (mutation (c) on
// `ownership-store.ts:36`): every existing test that exercises
// `productionWarningSink` injects its OWN `write` and asserts the
// structured `StateWarning` object, never the LINE the default sink writes
// to `write` (`workflow: <cause> run=<runId> fence=<fence>`). Dropping the
// `workflow: ` prefix — the actual mutation the `qa` pasted — left the
// whole suite green. This test calls `productionWarningSink` directly with
// a spy `write` and asserts the exact formatted line.
describe("productionWarningSink (issue #143): the exact formatted line", () => {
  it("formats a warning as workflow: <cause> run=<runId> fence=<fence>", () => {
    const lines: string[] = [];
    const sink = productionWarningSink((line) => lines.push(line));
    sink({ cause: "STALE_FENCE_WRITE", runId: "run-143", fence: 7 });
    expect(lines).toEqual(["workflow: STALE_FENCE_WRITE run=run-143 fence=7"]);
  });
});

// Molded on `tests/orchestration-child-runner-mutation-catalog.test.ts`
// (#112) and its siblings in `tests/workflow-shutdown.test.ts` (#129) and
// `tests/workflow-progress-cobertura.test.ts` (#138): pins the catalog
// entry's `before` as exact source text ahead of the slower
// `npm run mutations:t16`, so a drift in `ownership-store.ts`'s format
// string fails here first.
const ownershipStoreSource = readFileSync(
  resolve(__dirname, "..", "src/workflow/ownership-store.ts"),
  "utf8",
);

const SINK_PREFIX_MUTANT_ID = "ar/sink-drops-the-workflow-prefix";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mutations:t16 catalog pins ownership-store.ts's warning line format (#143)", () => {
  const mutant = orchestrationMutants.find((candidate) => candidate.id === SINK_PREFIX_MUTANT_ID);

  it(`mutants-orchestration.ts declares ${SINK_PREFIX_MUTANT_ID}`, () => {
    expect(mutant).toBeDefined();
  });

  it(`${SINK_PREFIX_MUTANT_ID}'s pinned "before" occurs exactly once, verbatim, in ownership-store.ts`, () => {
    const before = mutant?.edits[0]?.before ?? "";
    expect(before.length).toBeGreaterThan(0);
    expect(occurrences(ownershipStoreSource, before)).toBe(1);
  });

  it(`${SINK_PREFIX_MUTANT_ID}'s focus names this file's format test`, () => {
    expect(mutant?.focus.file).toBe("tests/workflow-durable-roots.test.ts");
    expect(mutant?.focus.test).toBe(
      "formats a warning as workflow: <cause> run=<runId> fence=<fence>",
    );
  });
});
