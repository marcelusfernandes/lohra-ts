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
// Issue #980 (S3): o mesmo para o `loop` — um `leaf.started{role:"loop.round",
// attempt:r}` e um `cache.stored` por rodada, o resume que continua da rodada em
// que parou (`cache.replayed` nas feitas, só a próxima gasta leaf) e o preview.
// Issue #981 (S4): o mesmo para o `escalate` — o `node.paused{reason:"escalated"}` do
// ledger sem leaf nem célula, a célula só depois de respondido, o preview
// (`escalation_pending` no nó que parou o run, `no_leaves` no que não disparou).
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

/**
 * Every leaf completes at once; a prompt that starts with `classify` answers `{kind:
 * "investigate"}`, and one that starts with `refine` answers a note that grows with the round it
 * names (`round 0` is 3, `round 1` is 6, `round 2` is 9) — unless `behavior.failRound` is that
 * round, whose leaf dies.
 */
interface Behavior {
  failRound: number | null;
}

function completingRuntime(behavior: Behavior): ChildRuntime {
  const prompts = new Map<string, string>();
  let seq = 0;
  return {
    spawn: (request: ChildSpawnRequest): string => {
      seq += 1;
      const id = `leaf-${String(seq)}`;
      prompts.set(id, request.prompt);
      return id;
    },
    collect: (id: string): ChildResult => {
      const prompt = prompts.get(id) ?? "";
      if (prompt.startsWith("scan"))
        return { status: "complete", output: { risk: 9 }, usage: USAGE };
      if (prompt.startsWith("refine")) {
        const round = Number(/round (\d+)/u.exec(prompt)?.[1] ?? "0");
        if (round === behavior.failRound) return { status: "failed", output: "dead leaf" };
        return { status: "complete", output: { score: 3 * round + 3 }, usage: USAGE };
      }
      return {
        status: "complete",
        output: prompt.startsWith("classify") ? { kind: "investigate" } : { ok: true },
        usage: USAGE,
      };
    },
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };
}

function harness() {
  const behavior: Behavior = { failRound: null };
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
    runtime: completingRuntime(behavior),
    auditTrail: new AuditTrail(audit),
    store,
  });
  return {
    service,
    repository,
    audit,
    behavior,
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
  readonly identity: Readonly<Record<string, unknown>>;
}

function eventsOf(h: Harness, runId: string, nodeId: string, segmentId?: string): readonly Seen[] {
  const page = h.audit.query({
    runId,
    limit: 500,
    ...(segmentId === undefined ? {} : { segmentId }),
  });
  return page.events
    .filter((event) => (event.identity.node_path as readonly string[] | undefined)?.[0] === nodeId)
    .map((event) => ({ type: event.event_type, data: event.data, identity: event.identity }));
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

const REFINE_BODY = { prompt: "refine round ${round}, so far ${so_far}" };

/** Grows 3, 6, 9 per round (`completingRuntime`): `gte 8` holds on the third. */
const refineSpec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  meta: { name: "loop-flow" },
  nodes: [
    { id: "free", type: "agent", prompt: "unpinned" },
    {
      id: "refine",
      type: "loop",
      provider: "p1",
      body: REFINE_BODY,
      until: { gte: { path: "${last.score}", n: 8 } },
      max_rounds: 5,
      ...extra,
    },
  ],
});

/** Waits for the run to stop, whatever the status: a loop that stops short is `failed`/`degraded`. */
async function settle(h: Harness, runId: string): Promise<string> {
  const status = (await h.service.status(runId, true)) as { status: string };
  return status.status;
}

async function launchLoop(h: Harness, raw: unknown): Promise<{ runId: string; status: string }> {
  const started = h.service.start(raw, {});
  if ("error" in started) throw new Error(started.error);
  return { runId: started.run_id, status: await settle(h, started.run_id) };
}

async function resumeLoop(h: Harness, runId: string): Promise<{ segment: string; status: string }> {
  const resumed = h.service.start(null, {}, { resumeRunId: runId });
  if ("error" in resumed) throw new Error(resumed.error);
  const status = await settle(h, runId);
  const row = h.repository.getRunState(runId) as Record<string, unknown>;
  return { segment: String(row.audit_segment_id), status };
}

describe("the ledger holds one leaf per round (#980)", () => {
  it("leaf.started{loop.round, attempt: r} and a cache.stored for each round that ran, and no more", async () => {
    const h = harness();
    try {
      const { runId, status } = await launchLoop(h, refineSpec());
      expect(status).toBe("complete");
      const events = eventsOf(h, runId, "refine");
      const started = ofType(events, "leaf.started");
      expect(started.map((event) => event.data.role)).toEqual([
        "loop.round",
        "loop.round",
        "loop.round",
      ]);
      expect(started.map((event) => event.identity.attempt)).toEqual([0, 1, 2]);
      expect(ofType(events, "leaf.completed")).toHaveLength(3);
      expect(ofType(events, "cache.stored")).toHaveLength(3);
      // The node already holds the earlier rounds' cells by the time a later round misses, which
      // is all `identity_changed` means for a node with one cell per round (the skill says so).
      expect(ofType(events, "cache.missed").map((event) => event.data.reason)).toEqual([
        "never_completed",
        "identity_changed",
        "identity_changed",
      ]);
      expect(ofType(events, "workflow.node").at(-1)?.data).toMatchObject({ state: "complete" });
    } finally {
      h.close();
    }
  });

  it("a loop that holds on round 0 leaves a single leaf and no trace of the rounds that never ran", async () => {
    const h = harness();
    try {
      const raw = refineSpec({ until: { gte: { path: "${last.score}", n: 1 } } });
      const { runId } = await launchLoop(h, raw);
      const events = eventsOf(h, runId, "refine");
      expect(ofType(events, "leaf.started")).toHaveLength(1);
      expect(ofType(events, "cache.stored")).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("a resume continues from the round it stopped at (#980)", () => {
  it("rounds 0 and 1 are cache.replayed with no leaf; only round 2 runs, and the loop completes", async () => {
    const h = harness();
    try {
      h.behavior.failRound = 2;
      const first = await launchLoop(h, refineSpec());
      expect(first.status).not.toBe("complete");
      expect(ofType(eventsOf(h, first.runId, "refine"), "leaf.started")).toHaveLength(3);

      h.behavior.failRound = null;
      const second = await resumeLoop(h, first.runId);
      expect(second.status).toBe("complete");
      const events = eventsOf(h, first.runId, "refine", second.segment);
      expect(ofType(events, "cache.replayed")).toHaveLength(2);
      const started = ofType(events, "leaf.started");
      expect(started).toHaveLength(1);
      expect(started[0]?.data).toMatchObject({ role: "loop.round" });
      expect(started[0]?.identity.attempt).toBe(2);
      expect(ofType(events, "cache.stored")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("a resume of a loop that finished replays every round and spawns nothing", async () => {
    const h = harness();
    try {
      const first = await launchLoop(h, refineSpec());
      const second = await resumeLoop(h, first.runId);
      const events = eventsOf(h, first.runId, "refine", second.segment);
      expect(ofType(events, "cache.replayed")).toHaveLength(3);
      expect(ofType(events, "leaf.started")).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("workflow_preview over a loop (#980)", () => {
  it("replay when nothing moved, recompute when the route moved the cells", async () => {
    const h = harness();
    try {
      const { runId } = await launchLoop(h, refineSpec());
      const same = await h.preview(runId);
      if ("error" in same) throw new Error(same.error);
      expect(outcomeOf(same.nodes, "refine").outcome).toBe("replay");
      expect(same.leaves_to_spawn).toBe(0);
      expect(same.engine_faults).toBe(0);

      const moved = await h.preview(runId, { provider: "p2" });
      if ("error" in moved) throw new Error(moved.error);
      expect(outcomeOf(moved.nodes, "refine").outcome).toBe("recompute");
      expect(outcomeOf(moved.nodes, "free").outcome).toBe("replay");
      expect(moved.leaves_to_spawn).toBeGreaterThanOrEqual(1);
    } finally {
      h.close();
    }
  });

  it("a loop that stopped at round 2 previews as recompute: the replayed rounds do not hide the one still to run", async () => {
    const h = harness();
    try {
      h.behavior.failRound = 2;
      const { runId } = await launchLoop(h, refineSpec());
      const result = await h.preview(runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "refine").outcome).toBe("recompute");
      expect(result.leaves_to_spawn).toBe(1);
      expect(result.engine_faults).toBe(0);
    } finally {
      h.close();
    }
  });
});
const reviewSpec = (
  extra: Record<string, unknown> = {},
  scan: Record<string, unknown> = {},
): Record<string, unknown> => ({
  meta: { name: "escalate-flow" },
  nodes: [
    { id: "scan", type: "agent", prompt: "scan the change", ...scan },
    {
      id: "review",
      type: "escalate",
      when: { gte: { path: "${scan.risk}", n: 7 } },
      kind: "high_risk",
      summary: "Risk ${scan.risk}",
      ...extra,
    },
    { id: "ship", type: "agent", prompt: "ship it", depends_on: ["review"] },
  ],
});

/** A `review` that never fires: the scan answers 9 and the bar is 10. */
const calmSpec = (): Record<string, unknown> =>
  reviewSpec({ when: { gte: { path: "${scan.risk}", n: 10 } } });

const nodePaused = (runId: string, h: Harness): readonly Seen[] =>
  ofType(
    h.audit.query({ runId, limit: 500 }).events.map((event) => ({
      type: event.event_type,
      data: event.data,
      identity: event.identity,
    })),
    "node.paused",
  );

describe("the ledger records the escalation, with no leaf and no cell of its own (#981)", () => {
  it("one node.paused{reason:escalated} under the node, and nothing else of its own", async () => {
    const h = harness();
    try {
      const { runId, status } = await launchLoop(h, reviewSpec());
      expect(status).toBe("paused");
      const paused = nodePaused(runId, h);
      expect(paused).toHaveLength(1);
      expect(paused[0]?.data.reason).toBe("escalated");
      expect(paused[0]?.identity.node_path).toEqual(["review"]);

      // The lookup misses (as a checkpoint's does), but nothing is stored before the answer.
      const events = eventsOf(h, runId, "review");
      expect(ofType(events, "leaf.started")).toEqual([]);
      expect(ofType(events, "cache.stored")).toEqual([]);
      expect(ofType(events, "cache.missed")).toHaveLength(1);
      expect(ofType(events, "workflow.node").at(-1)?.data).toMatchObject({
        state: "null",
      });
    } finally {
      h.close();
    }
  });

  it("the answer stores one cell and asks no leaf; the next resume only replays it", async () => {
    const h = harness();
    try {
      const first = await launchLoop(h, reviewSpec());
      const answered = h.service.start(
        null,
        {},
        { resumeRunId: first.runId, checkpointAnswers: { review: "approved" } },
      );
      if ("error" in answered) throw new Error(answered.error);
      expect(await settle(h, first.runId)).toBe("complete");
      const row = h.repository.getRunState(first.runId) as Record<string, unknown>;
      const events = eventsOf(h, first.runId, "review", String(row.audit_segment_id));
      expect(ofType(events, "cache.stored")).toHaveLength(1);
      expect(ofType(events, "leaf.started")).toEqual([]);
      expect(nodePaused(first.runId, h)).toHaveLength(1);

      const again = await resumeLoop(h, first.runId);
      expect(again.status).toBe("complete");
      const replayed = eventsOf(h, first.runId, "review", again.segment);
      expect(ofType(replayed, "cache.replayed")).toHaveLength(1);
      expect(ofType(replayed, "leaf.started")).toEqual([]);
      expect(nodePaused(first.runId, h)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("a review that does not fire leaves no event of its own but its node state, and no pause", async () => {
    const h = harness();
    try {
      const { runId, status } = await launchLoop(h, calmSpec());
      expect(status).toBe("complete");
      const events = eventsOf(h, runId, "review");
      expect(ofType(events, "leaf.started")).toEqual([]);
      expect(events.filter((event) => event.type.startsWith("cache."))).toEqual([]);
      expect(ofType(events, "workflow.node").at(-1)?.data).toMatchObject({
        state: "complete",
      });
      expect(nodePaused(runId, h)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("workflow_preview over an escalate (#981)", () => {
  it("the node that stopped the run is escalation_pending; what comes after it is not claimed", async () => {
    const h = harness();
    try {
      const { runId } = await launchLoop(h, reviewSpec());
      const result = await h.preview(runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "review").outcome).toBe("escalation_pending");
      expect(outcomeOf(result.nodes, "scan").outcome).toBe("replay");
      expect(outcomeOf(result.nodes, "ship").outcome).toBe("unknown");
      expect(result.leaves_to_spawn).toBe(0);
      expect(result.engine_faults).toBe(0);
    } finally {
      h.close();
    }
  });

  it("an escalate the run never reached is not pending: only the one that paused it is", async () => {
    const h = harness();
    try {
      const raw = reviewSpec();
      (raw.nodes as Record<string, unknown>[]).push({
        id: "late",
        type: "escalate",
        when: { gte: { path: "${scan.risk}", n: 1 } },
        kind: "late_review",
        summary: "later",
        depends_on: ["review"],
      });
      const { runId } = await launchLoop(h, raw);
      const result = await h.preview(runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "review").outcome).toBe("escalation_pending");
      expect(outcomeOf(result.nodes, "late").outcome).toBe("unknown");
    } finally {
      h.close();
    }
  });

  it("an escalate whose condition cannot be read pauses the preview too, but it is upstream_missing, not pending — and what follows is not claimed", async () => {
    const h = harness();
    try {
      // Really: the scan answers 9, so `review` pauses the run. Under a route that moves the scan
      // the preview's scan dies, so `review` cannot read its `when`: it fails closed (pauses, with
      // the `upstream null` fault) instead of letting `late` through. The outcome is the one every
      // node downstream of a recompute gets, not `escalation_pending`.
      const raw = reviewSpec({}, { provider: "p1" });
      (raw.nodes as Record<string, unknown>[]).push({
        id: "late",
        type: "escalate",
        when: { not: { of: { field_true: { path: "${args.flag}" } } } },
        kind: "late_review",
        summary: "later",
        depends_on: ["review"],
      });
      const { runId } = await launchLoop(h, raw);
      const result = await h.preview(runId, { provider: "p2" });
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "scan").outcome).toBe("recompute");
      expect(outcomeOf(result.nodes, "review").outcome).toBe("upstream_missing");
      expect(outcomeOf(result.nodes, "late").outcome).toBe("unknown");
    } finally {
      h.close();
    }
  });

  it("an escalate whose summary cannot render is still escalation_pending: the person would be asked", async () => {
    const h = harness();
    try {
      const raw = reviewSpec({ summary: "Risk ${scan.risk}: ${scan.reason}" });
      const { runId, status } = await launchLoop(h, raw);
      expect(status).toBe("paused");
      const result = await h.preview(runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "review").outcome).toBe("escalation_pending");
      expect(outcomeOf(result.nodes, "ship").outcome).toBe("unknown");
    } finally {
      h.close();
    }
  });

  it("an answered escalate previews as replay", async () => {
    const h = harness();
    try {
      const first = await launchLoop(h, reviewSpec());
      const answered = h.service.start(
        null,
        {},
        { resumeRunId: first.runId, checkpointAnswers: { review: "approved" } },
      );
      if ("error" in answered) throw new Error(answered.error);
      expect(await settle(h, first.runId)).toBe("complete");
      const result = await h.preview(first.runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "review").outcome).toBe("replay");
      expect(result.leaves_to_spawn).toBe(0);
    } finally {
      h.close();
    }
  });

  it("an escalate that did not fire is no_leaves — there is nothing to replay or to pay", async () => {
    const h = harness();
    try {
      const { runId } = await launchLoop(h, calmSpec());
      const result = await h.preview(runId);
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "review").outcome).toBe("no_leaves");
      expect(result.leaves_to_spawn).toBe(0);
      expect(result.engine_faults).toBe(0);
    } finally {
      h.close();
    }
  });

  it("a when that reads an upstream the preview would have to recompute is upstream_missing", async () => {
    const h = harness();
    try {
      const { runId } = await launchLoop(h, reviewSpec({}, { provider: "p1" }));
      const result = await h.preview(runId, { provider: "p2" });
      if ("error" in result) throw new Error(result.error);
      expect(outcomeOf(result.nodes, "scan").outcome).toBe("recompute");
      expect(outcomeOf(result.nodes, "review").outcome).toBe("upstream_missing");
    } finally {
      h.close();
    }
  });
});
