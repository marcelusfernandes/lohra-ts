// Issue #462 (M11-S4, épico #458): `workflow_preview {run_id, route?}` — a
// dry-run of `run_workflow(resume_run_id, ...)` over the REAL engine, cache
// and durable state, decision 5 of the épico's map (a tool of its own, never
// a `run_workflow` flag). Molds `tests/workflow-route-override.test.ts`
// (real `WorkflowService` + sqlite, real cache) for the harness and
// `tests/workflow-audit-cache.test.ts` for the nested-workflow loader shape.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { composeSessionTools, createSessionToolBase } from "../src/commands/session-tools.js";
import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  SessionRepository,
  WorkflowRepository,
} from "../src/state/index.js";
import { templateLoader } from "../src/workflow/templates.js";
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
// #462, rodada 2 (revisor, controle-negativo): a base (`main`) não tem
// `src/workflow/cache-preview.ts` — um import ESTÁTICO daqui quebra a
// COLETA do arquivo inteiro na base (`Cannot find module`, `colecionou:
// false`), o que o classificador do controle-negativo (`lib.ts#ehFalhaEstrutural`)
// conta como `structural-red`, não `assertion-red`. `import type` some na
// compilação (tsx/vite apagam todo import só-de-tipo antes de rodar), então
// os tipos ficam estáticos; só o valor `previewResume` precisa do import
// DINÂMICO, dentro de cada `it` via `harness().preview` abaixo — assim a
// falha na base acontece DURANTE um teste que já foi coletado, e vira a
// falha desse teste (assertion-red), não uma falha de coleta do arquivo.
import type { PreviewDeps, PreviewNodeOutcome } from "../src/workflow/cache-preview.js";

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
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function snapshot(database: Database.Database, runId: string) {
  return {
    run_state: rowCount(database, "workflow_run_state"),
    node_cache: rowCount(database, "workflow_node_cache"),
    node_cost: rowCount(database, "workflow_node_cost"),
    audit_events: rowCount(database, "workflow_audit_events"),
    // Rodada 2 (revisor, non-blocking #2): as duas outras superfícies
    // duráveis do run — sem seam de escrita no preview, mas duas linhas a
    // mais fecham a asserção "zero efeito colateral" com exaustão maior.
    run_locks: rowCount(database, "workflow_run_locks"),
    operator_notices: rowCount(database, "operator_notices"),
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

function nodeOf(
  nodes: readonly PreviewNodeOutcome[],
  nodeId: string,
): PreviewNodeOutcome | undefined {
  return nodes.find((entry) => entry.node_id === nodeId);
}

describe("previewResume — route_fault pause, no route (#462 AC)", () => {
  it("replays the unpinned cell, reports the pinned one as recompute/never_completed, and writes nothing", async () => {
    const { service, repository, database, preview, close } = harness({
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

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      const free = nodeOf(result.nodes, "free");
      const pinned = nodeOf(result.nodes, "pinned");
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
    const { service, repository, database, preview, close } = harness({
      runtime: routingRuntime("bad-provider"),
    });
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const beforeSnapshot = snapshot(database, started.run_id);

      const result = await preview({
        tiers: {},
        runId: started.run_id,
        route: { provider: "good" },
        now: 1000,
      });
      if ("error" in result) throw new Error(result.error);
      expect(result.route_applied).toBe(true);
      expect(nodeOf(result.nodes, "free")?.outcome).toBe("replay");
      expect(nodeOf(result.nodes, "pinned")?.outcome).toBe("recompute");

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
    const { service, repository, preview, close } = harness({
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

      const result = await preview({
        tiers: {},
        runId: started.run_id,
        route: { provider: "p2" },
        now: 1000,
      });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "a")?.outcome).toBe("replay");
      const b = nodeOf(result.nodes, "b");
      expect(b?.outcome).toBe("recompute");
      expect(b?.reason).toBe("identity_changed");
      expect(result.pivots_used).toBe(0); // the preview itself never spends one

      // Rodada 2 (revisor, non-blocking #3): the preview only PRICED the
      // pivot — the REAL resume below is what actually spends it, exactly
      // once, closing the pair "preview never consumes, resume always does".
      const resumed = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "p2" },
        },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const after = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(after.status).toBe("complete");
      expect(after.pivots).toEqual([{ provider: "p2", channel: "operator" }]);
    } finally {
      close();
    }
  });
});

// Rodada 2 (revisor, AC1): pins `leaves_to_spawn`'s two documented shapes —
// "one per parallel branch" and "one per pipeline item, until that item's
// first miss". `parallel` has no routing fields at all (`nodes.ts`'s
// `NODE_SPECS.parallel` — no `routing: true`), so the route-pivot trick the
// identity_changed test uses cannot apply to it; instead this primes a
// durable run whose branches NEVER succeeded (a generic dead leaf, no
// errorKind — never pauses the run) and lets the preview attempt them all
// fresh, deterministically. `pipeline` DOES allow a per-stage route
// (`STAGE_FIELDS`), so its own test still uses the pivot.
describe("previewResume — leaves_to_spawn for parallel (N branches) and pipeline (items × first miss) (#462 AC1)", () => {
  /** Every spawn dies with a plain, un-typed failure — never pauses the
   * run (only `quota_exhausted`/a route-fault kind does), so the durable
   * priming run settles "complete" (degraded, with faults) instead of
   * pausing partway through. */
  function alwaysDeadRuntime(): ChildRuntime {
    return withSandbox({
      spawn: (): string => "leaf-dead",
      collect: (): ChildResult => ({ status: "failed", output: "boom" }),
      steer: () => undefined,
      cancel: () => undefined,
    });
  }

  it("a parallel node with no successful branch re-spawns exactly one leaf per branch", async () => {
    const { service, preview, close } = harness({ runtime: alwaysDeadRuntime() });
    try {
      const spec = {
        meta: { name: "preview-parallel" },
        nodes: [{ id: "par", type: "parallel", branches: ["b1", "b2", "b3"] }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      const par = nodeOf(result.nodes, "par");
      expect(par?.outcome).toBe("recompute");
      expect(par?.reason).toBe("never_completed");
      expect(result.leaves_to_spawn).toBe(3);
    } finally {
      close();
    }
  });

  it("a pipeline node whose stage-2 route pivoted re-spawns exactly one leaf per item (stage 1 replays)", async () => {
    const { service, preview, close } = harness({ runtime: completingRuntime() });
    try {
      const spec = {
        meta: { name: "preview-pipeline" },
        nodes: [
          {
            id: "pipe",
            type: "pipeline",
            items: ["i1", "i2"],
            stages: [{ prompt: "s1" }, { prompt: "s2", provider: "p1" }],
          },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({
        tiers: {},
        runId: started.run_id,
        route: { provider: "p2" },
        now: 1000,
      });
      if ("error" in result) throw new Error(result.error);
      const pipe = nodeOf(result.nodes, "pipe");
      expect(pipe?.outcome).toBe("recompute");
      expect(pipe?.reason).toBe("identity_changed"); // stage 1's cells still exist under "pipe"
      // One spawn per item — stage 1 (unpinned) replays for both, stage 2
      // (pinned) is each item's FIRST miss and its only spawn.
      expect(result.leaves_to_spawn).toBe(2);
      expect(result.cells_replayed).toBe(2); // stage 1 × 2 items
    } finally {
      close();
    }
  });
});

describe("previewResume — a checkpoint pause (#462 AC)", () => {
  it("reports the finished nodes as replay and the pending checkpoint as checkpoint_pending", async () => {
    const { service, repository, preview, close } = harness();
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

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "a")?.outcome).toBe("replay");
      expect(nodeOf(result.nodes, "b")?.outcome).toBe("replay");
      expect(nodeOf(result.nodes, "c")?.outcome).toBe("checkpoint_pending");
      expect(result.cells_replayed).toBe(2);
      expect(result.leaves_to_spawn).toBe(0);
      expect(result.tokens_saved).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});

// Rodada 2 (revisor, non-blocking #4): the two outcomes the tool's own
// description names but no test exercised yet.
describe("previewResume — upstream_missing and token_budget_exhausted outcomes (#462 AC)", () => {
  it("a node whose dependency never produced a value reports upstream_missing", async () => {
    const { service, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "preview-upstream-missing" },
        nodes: [
          { id: "upstream", type: "agent", prompt: "${args.missing}" },
          { id: "downstream", type: "agent", prompt: "use ${upstream.out}" },
        ],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "downstream")?.outcome).toBe("upstream_missing");
    } finally {
      close();
    }
  });

  it("a run already at/past its token budget reports the un-cached node as token_budget_exhausted", async () => {
    const { service, preview, close } = harness({ runtime: completingRuntime() });
    try {
      const spec = {
        meta: { name: "preview-budget" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "b", type: "agent", prompt: "two" },
        ],
      };
      const started = service.start(spec, {}, { tokenBudget: 1 });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "a")?.outcome).toBe("replay"); // spent for real before the cap bit
      expect(nodeOf(result.nodes, "b")?.outcome).toBe("token_budget_exhausted");
    } finally {
      close();
    }
  });
});

describe("previewResume — named errors (#462 AC)", () => {
  it("refuses an unknown run_id", async () => {
    const { preview, close } = harness();
    try {
      const result = await preview({ tiers: {}, runId: "does-not-exist", now: 1000 });
      if (!("error" in result)) throw new Error("expected a named error");
      expect(result.error).toContain("does-not-exist");
    } finally {
      close();
    }
  });

  it("refuses a run that is genuinely live under an unexpired lease", async () => {
    const { service, repository, preview, close } = harness({
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

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if (!("error" in result)) throw new Error("expected a named error");
      expect(result.error).toContain(started.run_id);
    } finally {
      close();
    }
  });

  it("allows an orphaned run (still 'running' but its lease has expired)", async () => {
    const { service, preview, close } = harness({
      runtime: hangingRuntime(),
    });
    try {
      const spec = {
        meta: { name: "preview-orphan" },
        nodes: [{ id: "a", type: "agent", prompt: "x" }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);

      const result = await preview({
        tiers: {},
        runId: started.run_id,
        now: 1000 + 900 + 1, // past the 900s lease ttl
      });
      expect("error" in result).toBe(false);
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
    const { service, repository, preview, close } = harness({ loader });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(before.status).toBe("complete");

      const result = await preview({ tiers: {}, loader, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      const sub = nodeOf(result.nodes, "sub");
      expect(sub?.outcome).toBe("nested");
      expect(sub?.cells_replayed).toBe(2);
      expect(sub?.leaves_to_spawn).toBe(0);
    } finally {
      close();
    }
  });

  it("without a loader, reports the nested node as unknown (documented gap before S6)", async () => {
    const { service, preview, close } = harness({ loader });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "sub")?.outcome).toBe("unknown");
    } finally {
      close();
    }
  });
});

// Issue #484 (M15, achado dos vereditos das PRs #478/#482): `session-tools.ts`
// registered `workflow_preview` WITHOUT the production `templateLoader`
// (`workflow_templates`'s own loader, wired since #464) — every 'workflow'
// node previewed as 'unknown' even with the ref's template right there on
// disk. Molde: `tests/workflow-templates.test.ts`'s `setupComposedTools`
// (the REAL composition root), but with a `WorkflowService` that actually
// RUNS the nested workflow first (`harness()`'s own shape above), not the
// bare `neverSpawnRuntime()` one that test uses for wiring-only checks.
describe("workflow_preview through composeSessionTools — production loader wiring (#484 AC1)", () => {
  const wiredInnerSpec = {
    meta: { name: "preview-wired-inner" },
    nodes: [
      { id: "x", type: "agent", prompt: "inner one" },
      { id: "y", type: "agent", prompt: "inner two" },
    ],
  };

  it("classifies a nested 'workflow' node as 'nested' using the SAME templateLoader session-tools.ts wires into WorkflowService", async () => {
    const home = mkdtempSync(join(tmpdir(), "lohra-cache-preview-wired-"));
    roots.push(home);
    mkdirSync(join(home, "workflows"), { recursive: true });
    writeFileSync(join(home, "workflows", "inner.json"), JSON.stringify(wiredInnerSpec), "utf8");

    const connection = openStateDatabase(join(home, "state.db"));
    try {
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
        runtime: completingRuntime(),
        auditTrail: trail,
        store,
        homeRoot: home,
        loader: templateLoader(home),
      });
      const sessions = new SessionRepository(
        connection.database,
        () => 1000,
        connection.ftsEnabled,
      );
      const base = createSessionToolBase(connection.database, {});
      const tools = composeSessionTools({
        base,
        home,
        cwd: home,
        environment: {},
        sessions,
        workflowService: service,
        orchestrationHandlers: {},
        visionRunner: {
          complete: () => Promise.reject(new Error("unused in this test")),
          close: () => {},
        },
        visionModel: "vision-model",
        supportsVision: false,
      });

      const started = service.start({
        meta: { name: "preview-wired-outer" },
        nodes: [{ id: "sub", type: "workflow", ref: "inner" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const raw = await tools.dispatch("workflow_preview", { run_id: started.run_id });
      const parsed = JSON.parse(raw) as {
        nodes?: readonly PreviewNodeOutcome[];
        error?: string;
      };
      expect(parsed.error).toBeUndefined();
      const sub = parsed.nodes?.find((entry) => entry.node_id === "sub");
      expect(sub?.outcome).toBe("nested");
      expect(sub?.cells_replayed).toBe(2);
    } finally {
      connection.close();
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

// Rodada 2 (revisor, BLOCKING 2 / AC3): `workflowPreviewHandler` itself
// (route/run_id validation, tiers loading, the happy-path envelope) had no
// coverage — the "builtin registry" describe above only exercises the
// FAIL-SAFE placeholder (builtins.ts), never the real handler. These call
// `workflowPreviewHandler(database, home)` directly, the same shape
// `composeSessionTools` wires (session-tools.ts). Oracle test (the handler
// already exists on this branch, written green — no red step makes sense
// for a validation boundary this small).
describe("workflowPreviewHandler — validation and the happy path (#462 AC3, rodada 2)", () => {
  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "lohra-cache-preview-home-"));
    roots.push(home);
    return home;
  }

  it("refuses a non-object 'route' (a number)", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "run-x", route: 42 })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("'route' must be an object");
    } finally {
      close();
    }
  });

  it("refuses an array 'route'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "run-x", route: [] })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("'route' must be an object");
    } finally {
      close();
    }
  });

  it("refuses a 'route' object naming neither 'provider' nor 'model'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "run-x", route: {} })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("'route' must be an object");
    } finally {
      close();
    }
  });

  it("refuses a whitespace-only 'route.provider'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "run-x", route: { provider: "  " } })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("route.provider");
      expect(out.error ?? "").toContain("non-empty");
    } finally {
      close();
    }
  });

  // Issue #484: `parseRouteArg`'s 'route.model' branch (cache-preview.ts,
  // ~:432) had no test — only its 'route.provider' twin above did. Same
  // molde, the other field.
  it("refuses a whitespace-only 'route.model'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "run-x", route: { model: "  " } })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("route.model");
      expect(out.error ?? "").toContain("non-empty");
    } finally {
      close();
    }
  });

  it("refuses a missing 'run_id'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({})) as { error?: string };
      // Issue #484: `toContain("run_id")` alone also matches an unrelated
      // message that merely mentions the field — the full, exact text pins
      // the actual named error `requireString` raises.
      expect(out.error).toBe("workflow_preview requires a non-empty string 'run_id'");
    } finally {
      close();
    }
  });

  it("refuses an empty-string 'run_id'", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: "" })) as { error?: string };
      expect(out.error).toBe("workflow_preview requires a non-empty string 'run_id'");
    } finally {
      close();
    }
  });

  it("surfaces an invalid workflow_tiers.json as a named error (TiersError)", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { database, close } = harness();
    try {
      const home = tempHome();
      writeFileSync(join(home, "workflow_tiers.json"), "not json");
      const handler = workflowPreviewHandler(database, home);
      const out = JSON.parse(await handler({ run_id: "does-not-exist" })) as {
        error?: string;
      };
      expect(out.error ?? "").toContain("workflow_tiers.json");
    } finally {
      close();
    }
  });

  it("happy path: returns the preview envelope via toolResult", async () => {
    const { workflowPreviewHandler } = await import("../src/workflow/cache-preview.js");
    const { service, database, close } = harness({ runtime: completingRuntime() });
    try {
      const spec = {
        meta: { name: "preview-handler-happy" },
        nodes: [{ id: "a", type: "agent", prompt: "x" }],
      };
      const started = service.start(spec);
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const handler = workflowPreviewHandler(database, tempHome());
      const out = JSON.parse(await handler({ run_id: started.run_id })) as Record<string, unknown>;
      expect(out.ok).toBe(true);
      expect(out.run_id).toBe(started.run_id);
      expect(out.route_applied).toBe(false);
      expect(out.pivots_used).toBe(0);
      expect(Array.isArray(out.nodes)).toBe(true);
    } finally {
      close();
    }
  });
});
