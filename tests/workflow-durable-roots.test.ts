import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationCore, type ChildRunner } from "../src/orchestration/core.js";
import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import {
  OrchestrationChildRuntime,
  productionHolder,
  productionOwnershipStore,
  RUN_LEASE_TTL,
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
