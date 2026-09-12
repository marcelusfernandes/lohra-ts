// Issue #462 (M11-S4, épico #458): `workflow_preview {run_id, route?}` — a
// dry-run of `run_workflow(resume_run_id, ...)` over the REAL engine, cache
// and durable state, decision 5 of the épico's map (a tool of its own, never
// a `run_workflow` flag). Molds `tests/workflow-route-override.test.ts`
// (real `WorkflowService` + sqlite, real cache) for the harness and
// `tests/workflow-audit-cache.test.ts` for the nested-workflow loader shape.
//
// RED on `main`: `src/workflow/cache-preview.js` does not exist (dynamic
// import inside each `it`, per convention, so a module-not-found failure is
// isolated per test) and the tool registry still counts 28 tools / 23
// child-excluded names — the pin assertions below fail on their own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { durableFromRow, WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import type { WorkflowLoader } from "../src/workflow/engine-contract.js";

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

function withSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** One leaf per spawn — fails with `auth_failed` while the request's
 * `provider` is `badProvider`, completes otherwise. Same shape as
 * `workflow-route-override.test.ts`'s `RoutingFakeRuntime`. */
function routingRuntime(badProvider: string): ChildRuntime {
  let seq = 0;
  const providerById = new Map<string, string | null>();
  return withSandbox({
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
  });
}

/** Every leaf completes immediately, deterministic output. */
function completingRuntime(): ChildRuntime {
  let seq = 0;
  return withSandbox({
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

/** Never resolves — keeps a run genuinely "running" under a live lease. */
function hangingRuntime(): ChildRuntime {
  return withSandbox({
    spawn: (): string => "leaf-hanging",
    collect: (): Promise<ChildResult> => new Promise<ChildResult>(() => undefined),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

function harness(
  options: { readonly runtime?: ChildRuntime; readonly loader?: WorkflowLoader } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lohra-cache-preview-"));
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
  const service = new WorkflowService({
    runtime: options.runtime ?? completingRuntime(),
    auditTrail: trail,
    store,
    ...(options.loader === undefined ? {} : { loader: options.loader }),
  });
  return {
    service,
    repository,
    locks,
    database: connection.database,
    close: (): void => {
      connection.close();
    },
  };
}

function rowCount(database: import("better-sqlite3").Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function snapshot(database: import("better-sqlite3").Database, runId: string) {
  return {
    run_state: rowCount(database, "workflow_run_state"),
    node_cache: rowCount(database, "workflow_node_cache"),
    node_cost: rowCount(database, "workflow_node_cost"),
    audit_events: rowCount(database, "workflow_audit_events"),
    row: database.prepare("SELECT * FROM workflow_run_state WHERE run_id = ?").get(runId),
  };
}

function cacheSpec(): Record<string, unknown> {
  return {
    meta: { name: "preview-cache" },
    nodes: [
      { id: "free", type: "agent", prompt: "unpinned" },
      { id: "pinned", type: "agent", prompt: "pinned", provider: "bad-provider" },
    ],
  };
}

describe("previewResume — route_fault pause, no route (#462 AC)", () => {
  it("replays the unpinned cell, reports the pinned one as recompute/never_completed, and writes nothing", async () => {
    const { service, repository, locks, database, close } = harness({
      runtime: routingRuntime("bad-provider"),
    });
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(before.pause_reason).toBe("route_fault");
      const beforeSnapshot = snapshot(database, started.run_id);

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        now: 1000,
      });
      expect(result.error).toBeUndefined();
      const nodes = result.nodes as readonly Record<string, unknown>[];
      const free = nodes.find((entry) => entry.node_id === "free");
      const pinned = nodes.find((entry) => entry.node_id === "pinned");
      expect(free?.outcome).toBe("replay");
      expect(pinned?.outcome).toBe("recompute");
      expect(pinned?.reason).toBe("never_completed");
      expect(result.route_applied).toBe(false);
      expect(result.pivots_used).toBe(0);
      expect(result.leaves_to_spawn).toBe(1);
      expect(result.cells_replayed).toBe(1);

      const afterSnapshot = snapshot(database, started.run_id);
      expect(afterSnapshot).toEqual(beforeSnapshot);
      const after = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(after.pivots).toEqual(before.pivots);
    } finally {
      close();
    }
  });

  it("with 'route' applied, still writes nothing and does not consume a pivot", async () => {
    const { service, repository, locks, database, close } = harness({
      runtime: routingRuntime("bad-provider"),
    });
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const beforeSnapshot = snapshot(database, started.run_id);

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        route: { provider: "good" },
        now: 1000,
      });
      expect(result.error).toBeUndefined();
      expect(result.route_applied).toBe(true);
      const nodes = result.nodes as readonly Record<string, unknown>[];
      expect(nodes.find((entry) => entry.node_id === "free")?.outcome).toBe("replay");
      expect(nodes.find((entry) => entry.node_id === "pinned")?.outcome).toBe("recompute");

      const afterSnapshot = snapshot(database, started.run_id);
      expect(afterSnapshot).toEqual(beforeSnapshot);
      const after = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(after.pivots).toEqual([]); // never consumed
    } finally {
      close();
    }
  });
});

describe("previewResume — a route pivot reveals a cell whose identity moved (#462 AC)", () => {
  it("a node that completed under an OLD route reports recompute/identity_changed under a NEW one", async () => {
    const { service, repository, locks, database, close } = harness({
      runtime: completingRuntime(),
    });
    try {
      const spec = {
        meta: { name: "preview-identity" },
        nodes: [
          { id: "a", type: "agent", prompt: "unpinned" },
          { id: "b", type: "agent", prompt: "pinned", provider: "p1" },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(before.status).toBe("complete");

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        route: { provider: "p2" },
        now: 1000,
      });
      const nodes = result.nodes as readonly Record<string, unknown>[];
      expect(nodes.find((entry) => entry.node_id === "a")?.outcome).toBe("replay");
      const b = nodes.find((entry) => entry.node_id === "b");
      expect(b?.outcome).toBe("recompute");
      expect(b?.reason).toBe("identity_changed");
    } finally {
      close();
    }
  });
});

describe("previewResume — a checkpoint pause (#462 AC)", () => {
  it("reports the finished nodes as replay and the pending checkpoint as checkpoint_pending", async () => {
    const { service, repository, locks, database, close } = harness();
    try {
      const spec = {
        meta: { name: "preview-checkpoint" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two" },
          { id: "c", type: "checkpoint", prompt: "go?" },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(before.pause_reason).toBe("checkpoint");

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        now: 1000,
      });
      const nodes = result.nodes as readonly Record<string, unknown>[];
      expect(nodes.find((entry) => entry.node_id === "a")?.outcome).toBe("replay");
      expect(nodes.find((entry) => entry.node_id === "b")?.outcome).toBe("replay");
      expect(nodes.find((entry) => entry.node_id === "c")?.outcome).toBe("checkpoint_pending");
      expect(result.cells_replayed).toBe(2);
      expect(result.leaves_to_spawn).toBe(0);
      expect(result.tokens_saved).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});

describe("previewResume — named errors (#462 AC)", () => {
  it("refuses an unknown run_id", async () => {
    const { repository, locks, database, close } = harness();
    try {
      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: "does-not-exist",
        now: 1000,
      });
      expect(typeof result.error === "string" ? result.error : "").toContain("does-not-exist");
    } finally {
      close();
    }
  });

  it("refuses a run that is genuinely live under an unexpired lease", async () => {
    const { service, repository, locks, database, close } = harness({
      runtime: hangingRuntime(),
    });
    try {
      const spec = {
        meta: { name: "preview-live" },
        nodes: [{ id: "a", type: "agent", prompt: "x" }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      const row = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(row.status).toBe("running");

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        now: 1000,
      });
      expect(typeof result.error === "string" ? result.error : "").toContain(started.run_id);
    } finally {
      close();
    }
  });

  it("allows an orphaned run (still 'running' but its lease has expired)", async () => {
    const { service, repository, locks, database, close } = harness({
      runtime: hangingRuntime(),
    });
    try {
      const spec = {
        meta: { name: "preview-orphan" },
        nodes: [{ id: "a", type: "agent", prompt: "x" }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        now: 1000 + 900 + 1, // past the 900s lease ttl
      });
      expect(result.error).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe("previewResume — a nested 'workflow' node (#462 AC)", () => {
  const innerSpec = {
    meta: { name: "preview-inner" },
    nodes: [
      { id: "x", type: "agent", prompt: "inner one" },
      { id: "y", type: "agent", prompt: "inner two" },
    ],
  };
  const loader: WorkflowLoader = (reference) => (reference === "inner" ? innerSpec : null);

  function nestedSpec(): Record<string, unknown> {
    return {
      meta: { name: "preview-nested" },
      nodes: [{ id: "sub", type: "workflow", ref: "inner" }],
    };
  }

  it("with a loader, aggregates the nested cells it already has as 'nested'", async () => {
    const { service, repository, locks, database, close } = harness({ loader });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(before.status).toBe("complete");

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        loader,
        runId: started.run_id,
        now: 1000,
      });
      const nodes = result.nodes as readonly Record<string, unknown>[];
      const sub = nodes.find((entry) => entry.node_id === "sub");
      expect(sub?.outcome).toBe("nested");
      expect(sub?.cells_replayed).toBe(2);
      expect(sub?.leaves_to_spawn).toBe(0);
    } finally {
      close();
    }
  });

  it("without a loader, reports the nested node as unknown (documented gap before S6)", async () => {
    const { service, repository, locks, database, close } = harness({ loader });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const { previewResume } = (await import("../src/workflow/cache-preview.js")) as {
        previewResume: (deps: unknown) => Promise<Record<string, unknown>>;
      };
      const result = await previewResume({
        database,
        repository,
        locks,
        tiers: {},
        runId: started.run_id,
        now: 1000,
      });
      const nodes = result.nodes as readonly Record<string, unknown>[];
      expect(nodes.find((entry) => entry.node_id === "sub")?.outcome).toBe("unknown");
    } finally {
      close();
    }
  });
});

describe("builtin registry — workflow_preview (#462 AC)", () => {
  it("registers 'workflow_preview' as the 29th tool", async () => {
    const { createBuiltinRegistry } = await import("../src/tools/builtins.js");
    const registry = createBuiltinRegistry();
    expect(registry.generation).toBe(29);
    const names = registry.getDefinitions().map((definition) => definition.function.name);
    expect(names).toContain("workflow_preview");
    expect(names.at(-1)).toBe("workflow_preview");
  });

  it("is excluded from the child subagent toolset", async () => {
    const { CHILD_EXCLUDED_TOOLS } = await import("../src/tools/child.js");
    expect(CHILD_EXCLUDED_TOOLS).toContain("workflow_preview");
    expect(CHILD_EXCLUDED_TOOLS).toHaveLength(24);
  });

  it("fails safe when dispatched without a session WorkflowService/database", async () => {
    const { createBuiltinRegistry } = await import("../src/tools/builtins.js");
    const registry = createBuiltinRegistry();
    const out = await registry.dispatch("workflow_preview", {});
    expect(JSON.parse(out)).toEqual({
      error: "workflow tools must be intercepted with a session WorkflowService",
    });
  });
});
