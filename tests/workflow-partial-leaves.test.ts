// Issue #517 (M16-S2, épico #490, ADR 0005): a cancelled leaf whose `usage`
// already includes an ESTIMATED spend from a call aborted in flight —
// `ChildResult.partial` (runtime.ts) — reaches `leaf.failed.data.partial`
// (audit-runtime.ts, through the sanitizer's BOOLEAN_FIELDS, audit-model.ts)
// and `workflow_status.partial_leaves` (accounting.ts's `RunResult`,
// exposed by service-rollup.ts's `resultView`). Molded on
// `tests/workflow-audit-leaf.test.ts` (real sqlite-backed
// `WorkflowService`/`AuditRepository`/`AuditTrail`, never `audit-runtime.ts`
// directly — that module is `service.ts`'s implementation detail). RED on
// `main` 167c2669: `BOOLEAN_FIELDS` has no `partial` entry, `collect()`'s
// failed/cancelled branch writes no `usage`, and `RunResult` has no
// `partialLeaves` field at all.
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
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";
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

function harness(options: { readonly runtime: ChildRuntime; readonly loader?: WorkflowLoader }) {
  const root = mkdtempSync(join(tmpdir(), "lohra-partial-leaves-"));
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
    runtime: options.runtime,
    auditTrail: trail,
    store,
    ...(options.loader === undefined ? {} : { loader: options.loader }),
  });
  return {
    service,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

function spec(): Record<string, unknown> {
  return { meta: { name: "partial-leaves" }, nodes: [{ id: "a", type: "agent", prompt: "one" }] };
}

/** A single leaf whose FIRST (non-timeout) collect comes back `cancelled`
 * with a partial, estimated usage — the exact shape S3 will eventually
 * produce for real; this issue only proves the plumbing carries it. */
function cancelledPartialRuntime(): ChildRuntime {
  return {
    spawn: (): string => "leaf-1",
    collect: (): ChildResult => ({
      status: "cancelled",
      output: null,
      usage: USAGE,
      usageUncertain: true,
      partial: true,
      errorKind: "cancelled",
    }),
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: () => ({ dispose: (): void => undefined }),
  };
}

function completingRuntime(): ChildRuntime {
  return {
    spawn: (): string => "leaf-1",
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: (): void => undefined,
    cancel: (): void => undefined,
    installLeafSandbox: () => ({ dispose: (): void => undefined }),
  };
}

const innerSpec = {
  meta: { name: "inner-partial" },
  nodes: [{ id: "leaf", type: "agent", prompt: "inner work" }],
};

function nestedSpec(): Record<string, unknown> {
  return {
    meta: { name: "outer-partial" },
    nodes: [{ id: "sub", type: "workflow", ref: "inner-partial" }],
  };
}

describe("partial leaf accounting — leaf.failed and workflow_status (#517)", () => {
  it("a cancelled leaf with partial usage: leaf.failed carries partial:true, error_kind:cancelled and usage; workflow_status counts it in both partial_leaves and usage_uncertain_leaves", async () => {
    const { service, audit, close } = harness({ runtime: cancelledPartialRuntime() });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.partial_leaves).toBe(1);
      expect(final.usage_uncertain_leaves).toBe(1);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.failed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        status: "cancelled",
        error_kind: "cancelled",
        partial: true,
        usage: { tokens_in: USAGE.inputTokens, tokens_out: USAGE.outputTokens },
        usage_uncertain: true,
      });
    } finally {
      close();
    }
  });

  it("contra-assertion: a complete leaf with no partial usage leaves partial_leaves at 0 and leaf.completed without a partial key at all", async () => {
    const { service, audit, close } = harness({ runtime: completingRuntime() });
    try {
      const started = service.start(spec());
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.partial_leaves).toBe(0);
      expect(final.usage_uncertain_leaves).toBe(0);
      const page = audit.query({ runId: started.run_id, limit: 50 });
      const terminal = page.events.filter((event) => event.event_type === "leaf.completed");
      expect(terminal).toHaveLength(1);
      expect(Object.hasOwn(terminal[0]?.data ?? {}, "partial")).toBe(false);
    } finally {
      close();
    }
  });

  it("foldNestedCounters folds a nested sub-run's partialLeaves into the parent's own workflow_status.partial_leaves", async () => {
    const { service, close } = harness({
      runtime: cancelledPartialRuntime(),
      loader: () => innerSpec,
    });
    try {
      const started = service.start(nestedSpec());
      if ("error" in started) throw new Error(started.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.partial_leaves).toBe(1);
    } finally {
      close();
    }
  });
});
