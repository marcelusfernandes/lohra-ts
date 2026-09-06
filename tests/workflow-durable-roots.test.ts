import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OrchestrationCore } from "../src/orchestration/core.js";
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
  return openStateDatabase(join(root, "state.db"));
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

// --- Finding recorded on issue #101: the composition the issue describes
// cannot satisfy its own Acceptance Criteria within `## Files`. -------------
//
// `WorkflowService.start()` takes the durable path whenever `store` is set,
// and that path REQUIRES `runtime.installLeafSandbox`, refusing fail-closed
// (before any row is written) when it is absent — documented as intentional
// in `runtime.ts`: "optionality is compatibility, not permission to run
// leaves unsandboxed". `OrchestrationChildRuntime` — the runtime both
// chat.ts and dashboard.ts hand to WorkflowService — has no
// `installLeafSandbox`, and nothing else in src/orchestration installs one
// for it. So wiring `store` into chat.ts/dashboard.ts as this issue's AC 1
// describes does not make `run_workflow` durable: it makes every durable
// launch through those two roots refuse, a regression from today's working
// ephemeral run_workflow. AC 3/4 cannot go green within `## Files`. Full
// detail with file:line refs is on the #101 issue comment, not here (line
// numbers rot; the invariant this test fixes does not).
//
// When the production runtime gets a real `installLeafSandbox`, repoint this
// test at a stub runtime that still lacks one — the fail-closed refusal is
// the invariant under test, only the subject changes.
describe("blocker: OrchestrationChildRuntime cannot take the durable path (issue #101 finding)", () => {
  it("a durable launch over OrchestrationChildRuntime refuses LEAF_SANDBOX_UNAVAILABLE and writes no row", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database, { now: () => 1000 });
      const service = new WorkflowService({
        runtime: new OrchestrationChildRuntime({} as unknown as OrchestrationCore),
        store,
      });
      const started = service.start(spec(), {});
      expect("error" in started).toBe(true);
      if (!("error" in started)) throw new Error("expected a refusal");
      expect(started.cause).toBe("LEAF_SANDBOX_UNAVAILABLE");
      expect(runStateCount(connection.database)).toBe(0);
      expect(runSpendCount(connection.database)).toBe(0);
    } finally {
      connection.close();
    }
  });
});
