// Issue #368: `auditedWorkflowCache` decorates the durable node cache
// (`service.ts:826-ish`, `producers.wrapCache`) so every lookup and write a
// stretch makes produces `cache.replayed`/`cache.missed`/`cache.stored`/
// `cache.unavailable` in the ledger, with the SAME `segment_id` the rest of
// the stretch publishes and a scoped `node_id` (`cache.ts:39`'s optional
// third argument, threaded through the 4 `cache.get` call sites in
// `engine.ts`/`engine-utils.ts`).
//
// Deliberately built through `WorkflowService` + a real sqlite-backed
// `AuditRepository`/`WorkflowRepository`/`AuditTrail` + `SqliteWorkflowCache`
// (or an explicit `cacheFactory` for the refusal case), not through
// `audit-cache.ts` directly — that module is `service.ts`'s implementation
// detail; these tests pin the OBSERVABLE contract. RED on `main` decf7745:
// zero `cache.*` events ever reach the ledger (no producer wires a decorator
// around the node cache; `WorkflowCache.get` has no `nodeId` parameter).
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
import { MemoryWorkflowCache, type WorkflowCache } from "../src/workflow/cache.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";
import type { WorkflowLoader } from "../src/workflow/engine-contract.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 7,
  outputTokens: 11,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function withMinimalLeafSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** Every leaf completes immediately with `USAGE`, deterministic output —
 * the SAME content hash on a resume, so the cache actually hits. */
function completingRuntime(): ChildRuntime {
  let seq = 0;
  return withMinimalLeafSandbox({
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

function agentThenGateSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-cache" },
    nodes: [
      { id: "a", type: "agent", prompt: "one" },
      { id: "gate", type: "checkpoint", prompt: "go?" },
    ],
  };
}

const innerSpec = {
  meta: { name: "inner" },
  nodes: [{ id: "leaf", type: "agent", prompt: "inner work" }],
};

function nestedThenGateSpec(): Record<string, unknown> {
  return {
    meta: { name: "audit-cache-nested" },
    nodes: [
      { id: "sub", type: "workflow", ref: "inner" },
      { id: "gate", type: "checkpoint", prompt: "go?" },
    ],
  };
}

function harness(
  options: {
    readonly runtime?: ChildRuntime;
    readonly loader?: WorkflowLoader;
    readonly cacheFactory?: (runId: string) => WorkflowCache;
    readonly fenceMemory?: number;
    readonly onWarning?: (message: string) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-cache-"));
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
    ...(options.cacheFactory === undefined ? {} : { cacheFactory: options.cacheFactory }),
    ...(options.fenceMemory === undefined ? {} : { fenceMemory: options.fenceMemory }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
  return {
    service,
    repository,
    audit,
    trail,
    close: (): void => {
      connection.close();
    },
  };
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  const value = row.audit_segment_id;
  expect(typeof value).toBe("string");
  return value as string;
}

describe("workflow audit — cache producers (#368)", () => {
  it("miss then stored on the first run; replayed (with usage) on a resume — same node_id, same segment_id per stretch", async () => {
    const { service, repository, audit, close } = harness();
    try {
      const started = service.start(agentThenGateSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true); // settles paused at "gate"
      const firstSegment = segmentIdOf(repository, started.run_id);
      const firstPage = audit.query({ runId: started.run_id, limit: 50 });
      const firstCache = firstPage.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "a",
      );
      expect(firstCache.map((event) => event.event_type)).toEqual(["cache.missed", "cache.stored"]);
      for (const event of firstCache) {
        expect(event.identity.segment_id).toBe(firstSegment);
        expect(event.identity.node_path).toEqual(["a"]);
      }
      expect(firstCache[1]?.data.usage).toEqual({ tokens_in: 7, tokens_out: 11 });

      const resumed = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { gate: "yes" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const secondSegment = segmentIdOf(repository, started.run_id);
      const secondPage = audit.query({
        runId: started.run_id,
        segmentId: secondSegment,
        limit: 50,
      });
      const secondCache = secondPage.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "a",
      );
      expect(secondCache.map((event) => event.event_type)).toEqual(["cache.replayed"]);
      expect(secondCache[0]?.identity.node_path).toEqual(["a"]);
      expect(secondCache[0]?.data.usage).toEqual({ tokens_in: 7, tokens_out: 11 });
    } finally {
      close();
    }
  });

  it("a nested workflow's replayed cell carries a SCOPED node_path (sub.leaf)", async () => {
    const { service, repository, audit, close } = harness({ loader: () => innerSpec });
    try {
      const started = service.start(nestedThenGateSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const resumed = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { gate: "yes" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, segmentId, limit: 50 });
      const replayed = page.events.find((event) => event.event_type === "cache.replayed");
      expect(replayed?.identity.node_path).toEqual(["sub.leaf"]);
    } finally {
      close();
    }
  });

  it("put refused (fence obsolete) records cache.unavailable{reason:store_failed}, never a silent drop", async () => {
    const { service, audit, close } = harness({
      cacheFactory: () => new MemoryWorkflowCache({ refuseWrite: () => true }),
    });
    try {
      const started = service.start({
        meta: { name: "audit-cache-refused" },
        nodes: [{ id: "a", type: "agent", prompt: "one" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const cacheEvents = page.events.filter((event) => event.event_type.startsWith("cache."));
      expect(cacheEvents.map((event) => event.event_type)).toEqual([
        "cache.missed",
        "cache.unavailable",
      ]);
      expect(cacheEvents[1]?.data).toMatchObject({ reason: "store_failed" });
    } finally {
      close();
    }
  });

  it("fail-closed: cache.* produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger, and a warn names the drop", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-audit-cache-eviction-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const warnings: string[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let evicted = false;
      const runtime: ChildRuntime = withMinimalLeafSandbox({
        spawn: (): string => "leaf-1",
        collect: (): ChildResult => {
          const owner = running.service;
          if (!evicted && owner !== null) {
            evicted = true;
            const second = owner.start({
              meta: { name: "audit-cache-eviction-2" },
              nodes: [{ id: "a", type: "agent", prompt: "one" }],
            });
            if ("error" in second) throw new Error(second.error);
          }
          return { status: "complete", output: { ok: true }, usage: USAGE };
        },
        steer: () => undefined,
        cancel: () => undefined,
      });
      let n = 0;
      const service = new WorkflowService({
        runtime,
        auditTrail: trail,
        idSource: () => {
          n += 1;
          return `run-${String(n)}`;
        },
        // A plain in-memory cache (no fence check of its OWN) isolates the
        // AUDIT-level eviction below: the write to the cache itself succeeds,
        // only its audit event is dropped.
        cacheFactory: () => new MemoryWorkflowCache(),
        fenceMemory: 1,
        onWarning: (message) => warnings.push(message),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      running.service = service;
      const first = service.start({
        meta: { name: "audit-cache-eviction-1" },
        nodes: [{ id: "a", type: "agent", prompt: "one" }],
      });
      if ("error" in first) throw new Error(first.error);
      await service.status(first.run_id, true);
      expect(evicted).toBe(true);
      const page = audit.query({ runId: first.run_id, limit: 50 });
      const cacheEvents = page.events.filter((event) => event.event_type.startsWith("cache."));
      // the miss (recorded BEFORE the eviction) survives; the stored write
      // (recorded AFTER) is dropped, not silently — a warn names it.
      expect(cacheEvents.map((event) => event.event_type)).toEqual(["cache.missed"]);
      expect(
        warnings.some(
          (message) => message.includes("ownership lost") && message.includes("cache.stored"),
        ),
      ).toBe(true);
    } finally {
      connection.close();
    }
  });
});
