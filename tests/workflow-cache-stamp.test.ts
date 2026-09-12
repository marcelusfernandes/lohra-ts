// Issue #461 (M11-S3, épico #458): `cache.missed` ganha `reason`
// (`never_completed` | `identity_changed`) e `cache.replayed` ganha
// `version_state` (`current` | `stale` | `unstamped`) — carimbo
// `identity_version` gravado ao lado da célula (`workflow_node_cache`,
// coluna via `addedColumns`), NUNCA na chave (decisão 3 do épico #458,
// "marca, nunca invalida", `docs/decisions/2026-09-10-cache-escopo-irmaos.md`).
// A coluna `node_id` da célula passa a guardar o dono ESCOPADO (`sub1.a`,
// como `nodeCosts` de #348) em vez do id cru — fecha também #475.
//
// RED na base (main): `CELL_IDENTITY_VERSION`/`hasCellForNode` não existem,
// `CacheLookup` não tem `miss`/`versionState`, `getCacheCell` não devolve
// `identityVersion`, e a coluna `node_id` grava o id cru. Símbolos e campos
// novos são lidos via `as unknown as {...}` para que o arquivo COMPILE
// contra a base e o vermelho seja por asserção (undefined ≠ valor
// esperado), nunca por erro estrutural de import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
  type StateConnection,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import {
  contentHash,
  MemoryWorkflowCache,
  type CacheLookup,
  type WorkflowCache,
} from "../src/workflow/cache.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { validateSpec } from "../src/workflow/schema.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempDb(): StateConnection {
  const root = mkdtempSync(join(tmpdir(), "lohra-cache-stamp-"));
  roots.push(root);
  return openStateDatabase(join(root, "state.db"));
}

/** A REAL lease on run "test", so a direct `SqliteWorkflowCache`/
 * `WorkflowRepository` write below passes the ownership guard — a fixed
 * `{fence: 0, ...}` only works through `WorkflowService`, which acquires
 * its own lease internally before ever calling the cache. */
function leaseOwnership(connection: StateConnection): {
  fence: number;
  holder: string;
  now: number;
} {
  const locks = new LockRepository(connection.database);
  const fence = locks.acquireRunLease("run", "test", 1000, 900);
  if (fence === null) throw new Error("expected lease token");
  return { fence, holder: "test", now: 1000 };
}

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

/** Reads a field the base `CacheLookup` doesn't declare yet — `undefined`
 * there, the real classification once cache.ts/sqlite-cache.ts implement
 * it (#461). */
function missReason(lookup: CacheLookup): string | undefined {
  return (lookup as unknown as { readonly miss?: string }).miss;
}
function versionStateOf(lookup: CacheLookup): string | undefined {
  return (lookup as unknown as { readonly versionState?: string }).versionState;
}

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

describe("cell identity version — discipline (#461)", () => {
  it('CELL_IDENTITY_VERSION is pinned to "1" and the root cell hash formula is unchanged', async () => {
    const mod = (await import("../src/workflow/cache.js")) as unknown as {
      readonly CELL_IDENTITY_VERSION?: string;
    };
    expect(mod.CELL_IDENTITY_VERSION).toBe("1");
    // Same formula tests/workflow-parallel-cells.test.ts:287 pins for the
    // root compat case — a change to `runAgent`'s hashed parts must bump
    // the constant above in the SAME PR, not silently invalidate every
    // durable cell.
    const name = "cache-stamp-root-compat";
    const hash = contentHash(name, null, "a", "agent", "x", null, null, null);
    const cache = new MemoryWorkflowCache();
    cache.put("same", hash, "a", "cached-output", null);
    const runtime: ChildRuntime = {
      spawn: (): string => {
        throw new Error("must not spawn — root cell is a cache hit");
      },
      collect: (): ChildResult => ({ status: "failed", output: null }),
      steer: () => undefined,
      cancel: () => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
    };
    const engine = new WorkflowEngine({ runtime, cache, runId: "same" });
    const result = await engine.run(
      parsed({ meta: { name }, nodes: [{ id: "a", type: "agent", prompt: "x" }] }),
    );
    expect(result.outputs.a).toBe("cached-output");
  });
});

describe("cache.get without a nodeId — contra-assertion (#461 AC1)", () => {
  it("a miss with no nodeId given never carries a `miss` reason", () => {
    const cache = new MemoryWorkflowCache();
    const lookup = cache.get("run", "hash-does-not-exist");
    expect(lookup.hit).toBe(false);
    expect(missReason(lookup)).toBeUndefined();
  });
});

describe("cache.missed reason — never_completed vs identity_changed (#461)", () => {
  it("a node with no prior cell at all reads never_completed", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    const lookup = cache.get("run", "hash-1", "a");
    expect(lookup.hit).toBe(false);
    expect(missReason(lookup)).toBe("never_completed");
    connection.close();
  });

  it("the SAME node under a DIFFERENT hash (identity changed) reads identity_changed, not never_completed", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    cache.put("run", "hash-old", "a", { ok: true }, null);
    const lookup = cache.get("run", "hash-new", "a");
    expect(lookup.hit).toBe(false);
    expect(missReason(lookup)).toBe("identity_changed");
    connection.close();
  });
});

describe("cache.replayed version_state — carimbo, nunca invalida (#461, decisão 3)", () => {
  it("a cell written by THIS version replays as version_state 'current'", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    cache.put("run", "hash-a", "a", { ok: true }, null);
    const lookup = cache.get("run", "hash-a");
    expect(lookup.hit).toBe(true);
    expect(versionStateOf(lookup)).toBe("current");
    connection.close();
  });

  it("a pre-existing cell with no identity_version stamp replays as 'unstamped'", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    // Simulates a database written before #461: `putCacheCell` (no cost,
    // no identity stamp at all) never touches the new column.
    repository.putCacheCell("run", "hash-b", "a", "{}", "complete", ownership);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    const lookup = cache.get("run", "hash-b");
    expect(lookup.hit).toBe(true);
    expect(versionStateOf(lookup)).toBe("unstamped");
    connection.close();
  });

  it("a cell forged with an OLDER identity_version still replays (marked, never invalidated) as 'stale'", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    cache.put("run", "hash-c", "a", { ok: true }, null);
    connection.database
      .prepare(
        "UPDATE workflow_node_cache SET identity_version = ? WHERE run_id = ? AND content_hash = ?",
      )
      .run("0", "run", "hash-c");
    const lookup = cache.get("run", "hash-c");
    // Decisão 3 (marca, nunca invalida): o replay ainda acontece — só a
    // classificação muda.
    expect(lookup.hit).toBe(true);
    expect(lookup.output).toEqual({ ok: true });
    expect(versionStateOf(lookup)).toBe("stale");
    connection.close();
  });
});

describe("workflow_node_cache.node_id — dono ESCOPADO, não o id cru (#461, #475)", () => {
  const innerAgentSpec = {
    meta: { name: "inner-agent-stamp" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
  function siblingSpec(): Record<string, unknown> {
    return {
      meta: { name: "outer-siblings-stamp" },
      nodes: [
        { id: "sub1", type: "workflow", ref: "inner-agent-stamp" },
        { id: "sub2", type: "workflow", ref: "inner-agent-stamp", depends_on: ["sub1"] },
      ],
    };
  }

  function completingRuntime(): ChildRuntime {
    let seq = 0;
    return {
      spawn: (): string => {
        seq += 1;
        return `leaf-${String(seq)}`;
      },
      collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
      steer: () => undefined,
      cancel: () => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
    };
  }

  it("nested siblings reusing the same template write DISTINCT scoped node_id rows (sub1.a, sub2.a)", async () => {
    const connection = tempDb();
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
    const service = new WorkflowService({
      runtime: completingRuntime(),
      store,
      loader: () => innerAgentSpec,
    });
    const started = service.start(siblingSpec());
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const rows = connection.database
      .prepare("SELECT node_id FROM workflow_node_cache WHERE run_id = ? ORDER BY node_id")
      .all(started.run_id) as { readonly node_id: string }[];
    expect(rows.map((row) => row.node_id)).toEqual(["sub1.a", "sub2.a"]);
    connection.close();
  });

  it("a root-level agent's cell keeps the raw node_id — nodeScope empty is a no-op", async () => {
    const connection = tempDb();
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
    const service = new WorkflowService({ runtime: completingRuntime(), store });
    const started = service.start({
      meta: { name: "root-agent-stamp" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const rows = connection.database
      .prepare("SELECT node_id FROM workflow_node_cache WHERE run_id = ?")
      .all(started.run_id) as { readonly node_id: string }[];
    expect(rows.map((row) => row.node_id)).toEqual(["a"]);
    connection.close();
  });

  it("a pre-#461 row under the RAW node_id doesn't match a scoped lookup — reads never_completed, the declared limitation", () => {
    const connection = tempDb();
    const repository = new WorkflowRepository(connection.database);
    const ownership = leaseOwnership(connection);
    // An OLD database: a nested cell recorded under the raw node_id ("a"),
    // the pre-#461 convention — not the scoped "sub1.a" a fresh write from
    // THIS version would use.
    repository.putCacheCell("run", "old-hash", "a", "{}", "complete", ownership);
    const cache: WorkflowCache = new SqliteWorkflowCache(
      connection.database,
      "run",
      () => ownership,
      { repository },
    );
    const lookup = cache.get("run", "new-hash-for-sub1-a", "sub1.a");
    expect(lookup.hit).toBe(false);
    // Never "identity_changed": the column never matches "sub1.a" against
    // an old raw "a" row, so a miss here reads exactly as if the node had
    // never run — the limitation `docs/decisions/2026-09-13-carimbo-da-celula.md`
    // (#461) declares, not a silent misclassification.
    expect(missReason(lookup)).toBe("never_completed");
    connection.close();
  });
});

describe("cache.missed{reason} in the durable audit ledger — resume after a route pivot (#461 AC1)", () => {
  function harness(runtime: ChildRuntime) {
    const connection = tempDb();
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
    const service = new WorkflowService({ runtime, auditTrail: trail, store });
    return {
      service,
      repository,
      audit,
      close: (): void => {
        connection.close();
      },
    };
  }

  function segmentIdOf(repository: WorkflowRepository, runId: string): string {
    const row = repository.getRunState(runId) as Record<string, unknown>;
    return String(row.audit_segment_id);
  }

  function pinnedThenGateSpec(): Record<string, unknown> {
    return {
      meta: { name: "cache-stamp-pinned-pivot" },
      nodes: [
        { id: "a", type: "agent", prompt: "x", provider: "old" },
        { id: "gate", type: "checkpoint", prompt: "go?" },
      ],
    };
  }

  // Route unaffects completion here — the point is a hash that changes
  // between the two runs (provider "old" vs "new"), never an auth failure.
  const alwaysCompletes: ChildRuntime = {
    spawn: (): string => "leaf-1",
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };

  it("a resume that pivots an already-cached pinned node's route reads cache.missed{reason: identity_changed}", async () => {
    const { service, repository, audit, close } = harness(alwaysCompletes);
    try {
      const started = service.start(pinnedThenGateSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true); // "a" completes & caches; pauses at "gate"

      const resumed = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          checkpointAnswers: { gate: "yes" },
          routeOverride: { provider: "new" },
        },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);

      const secondSegment = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, segmentId: secondSegment, limit: 50 });
      const aEvents = page.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "a",
      );
      expect(aEvents.map((event) => event.event_type)).toEqual(["cache.missed", "cache.stored"]);
      expect(aEvents[0]?.data.reason).toBe("identity_changed");
    } finally {
      close();
    }
  });
});
