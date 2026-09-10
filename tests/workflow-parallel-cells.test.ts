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
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";

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
