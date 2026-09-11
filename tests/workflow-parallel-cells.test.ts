// Issue #241 / PR #305 round 2: the durable (SqliteWorkflowCache) half of
// the per-branch cache fix. `tests/workflow-hardening.test.ts` and
// `tests/workflow-service-durability.test.ts` were both already at the
// `arquivo-grande` line ceiling (no room to grow, confirmed against
// `origin/main`) — this file exists so the durable/Sqlite discriminating
// test has somewhere to live without either of them growing past base.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { usage } from "../src/pricing/usage.js";
import { contentHash, MemoryWorkflowCache } from "../src/workflow/cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { validateSpec } from "../src/workflow/schema.js";
import { WorkflowService } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

function noRuntime(): ChildRuntime {
  return {
    spawn: () => {
      throw new Error("must not spawn — group cell is a cache hit");
    },
    collect: () => ({ status: "failed", output: null }),
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("workflow parallel per-branch cells — durable path", () => {
  // The group cell used to also write what its branches already recorded,
  // doubling every token in `workflow_node_cost` — `seedSpend` sums cost
  // rows, so a resume could seed 2x real spend (15 real: 3 successful
  // leaves x usage1). A resume budgeted between 15 and 30 must be
  // accepted, not refused as already overspent.
  it("durable parallel group cell never double-records branch cost (#305)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-parallel-cells-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const usage1 = usage({ inputTokens: 3, outputTokens: 2 });
    const leaves = new Map<string, ChildResult>();
    let seq = 0;
    let bFailedOnce = false;
    const runtime: ChildRuntime = {
      spawn(request) {
        seq += 1;
        const id = `leaf-${String(seq)}`;
        const dead = request.prompt === "b" && !bFailedOnce;
        if (dead) bFailedOnce = true;
        if (dead) leaves.set(id, { status: "failed", output: null });
        else leaves.set(id, { status: "complete", output: "ok", usage: usage1 });
        return id;
      },
      collect: (id) => leaves.get(id) ?? { status: "failed", output: null },
      steer: () => undefined,
      cancel: () => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
    };
    const store = {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
      database: connection.database,
    };
    const service = new WorkflowService({ runtime, store });
    const spec = {
      meta: { name: "durable-parallel-cells" },
      nodes: [
        { id: "p", type: "parallel", branches: ["a", "b", "c"] },
        { id: "cp1", type: "checkpoint", prompt: "continue?", default: "yes" },
        { id: "cp2", type: "checkpoint", prompt: "continue2?" },
      ],
    };
    const started = service.start(spec);
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true); // p spawns a, b (fails), c; cp1 pauses
    // p re-runs: a, c reuse their own cell, b respawns and succeeds this
    // time — the group cell writes (for the first time) once it does.
    const run2 = service.start(null, {}, { resumeRunId: started.run_id });
    if ("error" in run2) throw new Error(run2.error);
    const paused2 = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused2.status).toBe("paused"); // cp2 has no default — pauses again
    const opts3 = {
      resumeRunId: started.run_id,
      tokenBudget: 20,
      checkpointAnswers: { cp2: "yes" },
    };
    const run3 = service.start(null, {}, opts3);
    if ("error" in run3) throw new Error(run3.error); // refused iff seeded spend miscounts
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(final.status).toBe("complete");
    expect(Number(final.tokens_in) + Number(final.tokens_out)).toBe(15);
    connection.close();
  });
});

describe("workflow parallel per-branch cells — group replay miss (#308)", () => {
  const spec = (name: string) =>
    parsed({
      meta: { name },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b", "c"] }],
    });

  // A group cell written by THIS version always carries cost: null, which
  // every WorkflowCache stores back as an all-zero Usage on read — never a
  // literal null on a hit (both MemoryWorkflowCache and SqliteWorkflowCache
  // convert null to a zeroed Usage on write). With that group cell present
  // but branch "c"'s own cell missing (evicted, or refused mid-write), the
  // miss must surface as a named fault instead of silently costing zero.
  it("group HIT with the group cell's own cost NULL and a branch cell missing faults by name", async () => {
    const cache = new MemoryWorkflowCache();
    const name = "group-replay-miss";
    const groupHash = contentHash(name, null, "p", "parallel", ["a", "b", "c"]);
    const branchHash = (index: number, prompt: string) =>
      contentHash(name, null, "p", "parallel", index, prompt);
    cache.put("same", groupHash, "p", ["a", "b", "c"], null);
    cache.put("same", branchHash(0, "a"), "p", "a", usage({ inputTokens: 1, outputTokens: 1 }));
    cache.put("same", branchHash(1, "b"), "p", "b", usage({ inputTokens: 1, outputTokens: 1 }));
    // branchHash(2, "c") intentionally never written — the missing cell.
    const missingHash = branchHash(2, "c");
    const engine = new WorkflowEngine({ runtime: noRuntime(), cache, runId: "same" });
    const result = await engine.run(spec(name));
    expect(result.outputs.p).toEqual(["a", "b", "c"]); // replay still returns the group output
    expect(result.faults).toContain(`group replay: per-branch cell missing for ${missingHash}`);
    expect(result.nodeCosts.p?.usage.inputTokens).toBe(2); // only a+b — c is faulted, not fabricated
  });

  // A database written before per-branch cells existed wrote the group
  // cell's own REAL total directly, with no branch cells at all — every
  // branch lookup misses there too, but that is expected shape for an old
  // database, not a hardening signal, and must never fault.
  it("group HIT with the group cell's own real cost and no branch cells never faults", async () => {
    const cache = new MemoryWorkflowCache();
    const name = "group-replay-old-db";
    const groupHash = contentHash(name, null, "p", "parallel", ["a", "b", "c"]);
    cache.put("same", groupHash, "p", ["a", "b", "c"], usage({ inputTokens: 5, outputTokens: 3 }));
    const engine = new WorkflowEngine({ runtime: noRuntime(), cache, runId: "same" });
    const result = await engine.run(spec(name));
    expect(result.outputs.p).toEqual(["a", "b", "c"]);
    expect(result.faults).toEqual([]);
    expect(result.nodeCosts.p?.usage.inputTokens).toBe(5);
    expect(result.nodeCosts.p?.usage.outputTokens).toBe(3);
  });
});

// #332: a nested `workflow` node's cell (agent, parallel, ...) keyed only on
// `specIdentity` + its own parts, with no `nodeScope` at all — unlike
// `runCheckpoint` (#319), which already folds `nodeScope` in. Two SIBLING
// `workflow` nodes reusing the SAME template with identical inputs (the
// User Story's exact shape: `sub1`/`sub2` both `ref: "inner"`) then share
// one cell: `sub2` replays `sub1`'s output with zero spawns and zero cost of
// its own, instead of running — and being charged for — its own real work.
class LabeledRuntime implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];

  spawn(request: ChildSpawnRequest): string {
    this.requests.push(request);
    return `leaf-${String(this.requests.length)}`;
  }

  collect(id: string): ChildResult {
    const index = Number(id.split("-")[1]);
    return {
      status: "complete",
      output: `out-${String(index)}`,
      usage: usage({ inputTokens: 4, outputTokens: 4 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

describe("nested siblings reusing an identical template — cell scope (#332)", () => {
  const innerAgentSpec = {
    meta: { name: "inner-agent" },
    nodes: [{ id: "a", type: "agent", prompt: "do the thing" }],
  };
  const innerParallelSpec = {
    meta: { name: "inner-parallel" },
    nodes: [{ id: "p", type: "parallel", branches: ["x", "y"] }],
  };
  // `depends_on` makes the root's sequential loop reach `sub1` before
  // `sub2` deterministic — same convention as the sibling checkpoint tests
  // in `tests/workflow-checkpoint-aninhado.test.ts` (#319).
  const siblings = (ref: string) => [
    { id: "sub1", type: "workflow", ref },
    { id: "sub2", type: "workflow", ref, depends_on: ["sub1"] },
  ];

  it("agent: each sibling spawns its OWN leaf and keeps its OWN output", async () => {
    const runtime = new LabeledRuntime();
    const result = await new WorkflowEngine({
      runtime,
      cache: new MemoryWorkflowCache(),
      runId: "same",
      loader: () => innerAgentSpec,
    }).run(parsed({ meta: { name: "outer-agent-siblings" }, nodes: siblings("inner-agent") }));
    expect(result.status).toBe("complete");
    expect(runtime.requests).toHaveLength(2); // one leaf per sibling, not one shared cell
    expect(result.outputs.sub1).toEqual({ a: "out-1" });
    expect(result.outputs.sub2).toEqual({ a: "out-2" }); // not sub1's "out-1"
    expect(result.tokensIn).toBe(8); // 2 real leaves x 4 tokens, not 4 (one leaf reused)
    // #348: `sub1`/`sub2` share `ref: "inner-agent"` — before the fix both
    // sub-runs' leaf ("a") folded to the SAME `sub[inner-agent]:a` key and
    // the second sibling silently overwrote the first's cost. Each nested
    // engine's own `nodeCosts` is now nodeScope-qualified (`debitLeaf`,
    // engine-utils.ts) before `runNested`'s untouched fold ever sees it, so
    // the two land on distinct keys instead of colliding.
    expect(Object.keys(result.nodeCosts)).toHaveLength(2);
    expect(result.nodeCosts["sub[inner-agent]:sub1.a"]?.usage.inputTokens).toBe(4);
    expect(result.nodeCosts["sub[inner-agent]:sub2.a"]?.usage.inputTokens).toBe(4);
  });

  it("parallel: each sibling's group AND per-branch cells are scope-qualified", async () => {
    const runtime = new LabeledRuntime();
    const result = await new WorkflowEngine({
      runtime,
      cache: new MemoryWorkflowCache(),
      runId: "same",
      loader: () => innerParallelSpec,
    }).run(
      parsed({ meta: { name: "outer-parallel-siblings" }, nodes: siblings("inner-parallel") }),
    );
    expect(result.status).toBe("complete");
    expect(runtime.requests).toHaveLength(4); // 2 branches x 2 siblings, not 2 (branches replayed)
    expect(result.outputs.sub1).toEqual({ p: ["out-1", "out-2"] });
    expect(result.outputs.sub2).toEqual({ p: ["out-3", "out-4"] });
  });

  // #348: a resume/replay of the SAME run hits the group cell (written with
  // cost `null` — PR #305) instead of spawning, so the branch/group cost path
  // is `recordGroupReplayCost`/`cacheGet` (engine-utils.ts), not `account`'s
  // fresh-spawn path the two tests above exercise. Both need the same
  // `nodeScope` qualifier or a replayed sibling's cost collides exactly like
  // the fresh-spawn one did.
  it("parallel: a replay's group AND branch cost land on the sibling's own scoped key", async () => {
    const cache = new MemoryWorkflowCache();
    const spec = () =>
      parsed({ meta: { name: "outer-parallel-siblings" }, nodes: siblings("inner-parallel") });
    const first = await new WorkflowEngine({
      runtime: new LabeledRuntime(),
      cache,
      runId: "same",
      loader: () => innerParallelSpec,
    }).run(spec());
    expect(first.status).toBe("complete");
    const replay = await new WorkflowEngine({
      runtime: noRuntime(), // replay must never spawn — every branch is a cache hit
      cache,
      runId: "same",
      loader: () => innerParallelSpec,
    }).run(spec());
    expect(replay.status).toBe("complete");
    expect(replay.nodeCosts["sub[inner-parallel]:sub1.p"]?.usage.inputTokens).toBe(8);
    expect(replay.nodeCosts["sub[inner-parallel]:sub2.p"]?.usage.inputTokens).toBe(8);
  });
});

describe("root cell identity is unchanged by the #332 scope fix — compat", () => {
  it("an agent's root cell hash matches the pre-#332 formula exactly", async () => {
    const cache = new MemoryWorkflowCache();
    const name = "root-agent-compat";
    // The same parts `runAgent` (engine.ts) always hashed at the root, before
    // and after #332: `nodeScope` is `[]` there, so folding it into
    // `specIdentity` contributes nothing — this is the hash a durable
    // database already holds for every existing root-level agent cell.
    const hash = contentHash(name, null, "a", "agent", "x", null, null, null);
    cache.put("same", hash, "a", "cached-output", null);
    const engine = new WorkflowEngine({ runtime: noRuntime(), cache, runId: "same" });
    const result = await engine.run(
      parsed({ meta: { name }, nodes: [{ id: "a", type: "agent", prompt: "x" }] }),
    );
    expect(result.outputs.a).toBe("cached-output"); // HIT — noRuntime() throws on spawn
  });
});
