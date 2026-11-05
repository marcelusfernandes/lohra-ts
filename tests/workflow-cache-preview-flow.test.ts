// Issue #979 (S2 do épico #976): o `switch` no que o operador enxerga — o
// ledger, o resume e o `workflow_preview`. Arquivo próprio porque
// `tests/workflow-cache-preview.test.ts` já está em 800 linhas (regra
// `arquivo-grande` do check `contratos`); a mesma costura (um
// `WorkflowService` real sobre sqlite, cache real) serve aos três.
//   - Ledger: só o `leaf.started{role:"switch.case", item_index:k}` do caso
//     escolhido; os outros casos não deixam evento algum, e um caso `null`
//     não deixa leaf nem célula.
//   - Resume: o mesmo valor emite `cache.replayed`; um valor mudado roda o caso
//     novo com `cache.missed{reason:"identity_changed"}`.
//   - Preview: `replay`, `recompute` (a rota mexeu na identidade) e, para um
//     caso `null`, `no_leaves`; um `value` que lê um upstream que teria de
//     rodar de novo é `upstream_missing`.
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
import { previewResume, type PreviewNodeOutcome } from "../src/workflow/cache-preview.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";

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

/** Every leaf completes at once; a prompt that starts with `classify` answers `{kind: "investigate"}`. */
function completingRuntime(): ChildRuntime {
  const prompts = new Map<string, string>();
  let seq = 0;
  return {
    spawn: (request: ChildSpawnRequest): string => {
      seq += 1;
      const id = `leaf-${String(seq)}`;
      prompts.set(id, request.prompt);
      return id;
    },
    collect: (id: string): ChildResult => ({
      status: "complete",
      output:
        prompts.get(id)?.startsWith("classify") === true ? { kind: "investigate" } : { ok: true },
      usage: USAGE,
    }),
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-switch-flow-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
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
    auditTrail: new AuditTrail(audit),
    store,
  });
  return {
    service,
    repository,
    audit,
    preview: (runId: string, route?: { readonly provider: string }) =>
      previewResume({
        database: connection.database,
        repository,
        locks,
        tiers: {},
        runId,
        ...(route === undefined ? {} : { route }),
        now: 1000,
      }),
    close: (): void => {
      connection.close();
    },
  };
}

type Harness = ReturnType<typeof harness>;

const CASES = {
  reuse: null,
  investigate: { prompt: "dig" },
  escalate: { prompt: "page" },
};

const spec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  meta: { name: "switch-flow" },
  nodes: [
    { id: "free", type: "agent", prompt: "unpinned" },
    {
      id: "sw",
      type: "switch",
      value: "${args.kind}",
      provider: "p1",
      cases: CASES,
      ...extra,
    },
  ],
});

async function finish(h: Harness, runId: string): Promise<void> {
  const status = await h.service.status(runId, true);
  expect(status).toMatchObject({ status: "complete" });
}

async function launch(h: Harness, raw: unknown, args: Record<string, unknown>): Promise<string> {
  const started = h.service.start(raw, args);
  if ("error" in started) throw new Error(started.error);
  await finish(h, started.run_id);
  return started.run_id;
}

async function resume(h: Harness, runId: string, args: Record<string, unknown>): Promise<string> {
  const resumed = h.service.start(null, args, { resumeRunId: runId });
  if ("error" in resumed) throw new Error(resumed.error);
  await finish(h, runId);
  const row = h.repository.getRunState(runId) as Record<string, unknown>;
  return String(row.audit_segment_id);
}

interface Seen {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function eventsOf(h: Harness, runId: string, nodeId: string, segmentId?: string): readonly Seen[] {
  const page = h.audit.query({
    runId,
    limit: 500,
    ...(segmentId === undefined ? {} : { segmentId }),
  });
  return page.events
    .filter((event) => (event.identity.node_path as readonly string[] | undefined)?.[0] === nodeId)
    .map((event) => ({ type: event.event_type, data: event.data }));
}

const ofType = (events: readonly Seen[], type: string): readonly Seen[] =>
  events.filter((event) => event.type === type);

function outcomeOf(nodes: readonly PreviewNodeOutcome[], nodeId: string): PreviewNodeOutcome {
  const found = nodes.find((entry) => entry.node_id === nodeId);
  if (found === undefined) throw new Error(`no outcome for ${nodeId}`);
  return found;
}

describe("the ledger holds only the chosen case (#979)", () => {
  it("one leaf.started, role switch.case, item_index = the case's position; nothing for the others", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "investigate" });
      const events = eventsOf(h, runId, "sw");
      const started = ofType(events, "leaf.started");
      expect(started).toHaveLength(1);
      expect(started[0]?.data).toMatchObject({ role: "switch.case", item_index: 1 });
      expect(ofType(events, "leaf.completed")).toHaveLength(1);
      expect(ofType(events, "cache.stored")).toHaveLength(1);
      expect(ofType(events, "cache.missed")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("a null case leaves no leaf and no cell, and the node still settles complete", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "reuse" });
      const events = eventsOf(h, runId, "sw");
      expect(ofType(events, "leaf.started")).toEqual([]);
      expect(events.filter((event) => event.type.startsWith("cache."))).toEqual([]);
      expect(ofType(events, "workflow.node").at(-1)?.data).toMatchObject({ state: "complete" });
    } finally {
      h.close();
    }
  });
});

describe("a resume re-reads the value (#979)", () => {
  it("the same value replays the cell: cache.replayed, and no leaf in the new stretch", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "investigate" });
      const segment = await resume(h, runId, { kind: "investigate" });
      const events = eventsOf(h, runId, "sw", segment);
      expect(ofType(events, "cache.replayed")).toHaveLength(1);
      expect(ofType(events, "leaf.started")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a changed value runs the new case, with cache.missed{reason: identity_changed}", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "investigate" });
      const segment = await resume(h, runId, { kind: "escalate" });
      const events = eventsOf(h, runId, "sw", segment);
      const missed = ofType(events, "cache.missed");
      expect(missed).toHaveLength(1);
      expect(missed[0]?.data.reason).toBe("identity_changed");
      const started = ofType(events, "leaf.started");
      expect(started).toHaveLength(1);
      expect(started[0]?.data).toMatchObject({ role: "switch.case", item_index: 2 });
    } finally {
      h.close();
    }
  });

  it("moving from a leaf case to the null case runs nothing and writes nothing", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "investigate" });
      const segment = await resume(h, runId, { kind: "reuse" });
      const events = eventsOf(h, runId, "sw", segment);
      expect(ofType(events, "leaf.started")).toEqual([]);
      expect(events.filter((event) => event.type.startsWith("cache."))).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("workflow_preview over a switch (#979)", () => {
  it("replay when nothing moved, recompute/identity_changed when the route moved the cell", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "investigate" });
      const same = await h.preview(runId);
      if ("error" in same) throw new Error(same.error);
      expect(outcomeOf(same.nodes, "sw").outcome).toBe("replay");
      expect(same.leaves_to_spawn).toBe(0);
      expect(same.engine_faults).toBe(0);

      const moved = await h.preview(runId, { provider: "p2" });
      if ("error" in moved) throw new Error(moved.error);
      expect(outcomeOf(moved.nodes, "sw")).toMatchObject({
        outcome: "recompute",
        reason: "identity_changed",
      });
      expect(outcomeOf(moved.nodes, "free").outcome).toBe("replay");
      expect(moved.leaves_to_spawn).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a null case is no_leaves, with or without a route: there is nothing to replay or pay", async () => {
    const h = harness();
    try {
      const runId = await launch(h, spec(), { kind: "reuse" });
      for (const route of [undefined, { provider: "p2" }]) {
        const result = await h.preview(runId, route);
        if ("error" in result) throw new Error(result.error);
        expect(outcomeOf(result.nodes, "sw").outcome).toBe("no_leaves");
        expect(result.leaves_to_spawn).toBe(0);
        expect(result.engine_faults).toBe(0);
      }
    } finally {
      h.close();
    }
  });

  it("a value that reads an upstream the preview would have to recompute is upstream_missing", async () => {
    const h = harness();
    try {
      const raw = {
        meta: { name: "switch-upstream" },
        nodes: [
          { id: "up", type: "agent", prompt: "classify this", provider: "p1" },
          { id: "sw", type: "switch", value: "${up.kind}", cases: CASES },
        ],
      };
      const runId = await launch(h, raw, {});
      const result = await h.preview(runId, { provider: "p2" });
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "up").outcome).toBe("recompute");
      expect(outcomeOf(result.nodes, "sw").outcome).toBe("upstream_missing");
    } finally {
      h.close();
    }
  });
});
