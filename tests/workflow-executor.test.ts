import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Budget,
  ESTIMATED_TOKENS_PER_LEAF,
  FanoutRejected,
  MemoryWorkflowCache,
  WorkflowEngine,
  contentHash,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";
import { WorkflowService } from "../src/workflow/service.js";
import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";

class FakeRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  readonly cancelled: string[] = [];
  readonly steered: string[] = [];
  private readonly scripts: ChildResult[][];
  private readonly byId = new Map<string, ChildResult[]>();

  constructor(scripts: ChildResult[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.spawned.length + 1)}`;
    this.spawned.push(request);
    this.byId.set(id, this.scripts.shift() ?? []);
    return id;
  }

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    const script = this.byId.get(id) ?? [];
    return script.shift() ?? { status: "failed", output: "script exhausted" };
  }

  steer(id: string, prompt: string): void {
    this.steered.push(`${id}:${prompt}`);
  }

  cancel(id: string): void {
    this.cancelled.push(id);
  }

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

class PoolRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  active = 0;
  peak = 0;

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `pool-${String(this.spawned.length)}`;
  }

  async collect(id: string): Promise<ChildResult> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    return complete(id);
  }

  steer(): void {}
  cancel(): void {}
}

const complete = (output: unknown, inputTokens = 1, outputTokens = 1): ChildResult => ({
  status: "complete",
  output,
  usage: {
    inputTokens,
    outputTokens,
    cacheReadTokens: 7,
    cacheWriteTokens: 11,
    reasoningTokens: 13,
  },
  provider: "stub",
  model: "canned",
});

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

describe("workflow budget and cache", () => {
  it("keeps token charging separate from report-only meters", () => {
    const budget = new Budget({ tokenBudget: 10 });
    budget.chargeTokens(7, 5);
    expect(budget.tokensSpent).toBe(12);
    expect(budget.tokensRemaining).toBe(0);
    expect(budget.tokensExhausted).toBe(true);
    expect(budget.snapshot()).toEqual({ total: 10, spent: 12, remaining: 0 });
  });

  it("uses measured average after the first non-zero charge", () => {
    const budget = new Budget({ tokenBudget: 10_000 });
    expect(budget.estimatedLeafCost).toBe(2000);
    budget.chargeTokens(50, 50);
    budget.chargeTokens(0, 0);
    expect(budget.estimatedLeafCost).toBe(100);
    expect(budget.affordableLeaves()).toBe(99);
  });

  it("excludes an uncertain leaf's charge from the measured average (#232)", () => {
    const budget = new Budget({ tokenBudget: 10_000 });
    budget.chargeTokens(200, 0);
    budget.chargeTokens(0, 0, true);
    // Only the first, measured charge counts: 200/1, not 200/2 — an
    // unmeasured leaf must never pull the average (and affordableLeaves)
    // down, even though its own tokens are zero either way.
    expect(budget.estimatedLeafCost).toBe(200);
  });

  it("never counts an uncertain leaf toward the average even with real, nonzero tokens (#232)", () => {
    // The previous test's uncertain leaf carried zero tokens, so
    // `(input > 0 || output > 0)` alone already excluded it — this pins the
    // `usageUncertain` guard itself, with a leaf that WOULD have qualified
    // on token count alone.
    const budget = new Budget({ tokenBudget: 10_000 });
    budget.chargeTokens(500, 0, true);
    expect(budget.estimatedLeafCost).toBe(ESTIMATED_TOKENS_PER_LEAF);
    // (10_000 - 500 already spent) / default 2000 — never / 500, which
    // would happen if the uncertain leaf's tokens leaked into the average.
    expect(budget.affordableLeaves()).toBe(4);
  });

  it("debits an uncertain leaf's tokens into tokensSpent but keeps them out of the average's numerator (#232)", () => {
    // Invariant 3 (budget never unbounded): the uncertain leaf's tokens
    // still count against the run's own ceiling — only the AVERAGE, used to
    // project affordableLeaves, must never be inflated by a leaf that was
    // never actually measured.
    const budget = new Budget({ tokenBudget: 10_000 });
    budget.chargeTokens(200, 0); // measured
    budget.chargeTokens(500, 0, true); // uncertain, real tokens
    expect(budget.tokensSpent).toBe(700);
    expect(budget.estimatedLeafCost).toBe(200); // 200/1, never (200+500)/1 or /2
  });

  it("rejects fanout before charging lifetime", () => {
    const budget = new Budget({ maxFanout: 2, lifetime: 3 });
    expect(() => {
      budget.checkFanout(3);
    }).toThrow(FanoutRejected);
    expect(budget.lifetimeRemaining).toBe(3);
  });

  it("matches the Python canonical hash and keeps run scope", () => {
    expect(contentHash("a", { z: 1, a: "á" })).toBe(
      "e8d95c0470f891397fdac905b97c6c6d9e8adcbca264d5f20c445f4fcfe7cbee",
    );
    const cache = new MemoryWorkflowCache();
    cache.put("r1", "h", "n", "value", complete("x").usage ?? null);
    expect(cache.get("r1", "h")).toMatchObject({ hit: true, output: "value" });
    expect(cache.get("r2", "h")).toMatchObject({ hit: false, output: null });
  });

  it("normalizes pool/lifetime defaults and never exceeds the configured pool", async () => {
    expect(new Budget({ poolWidth: 0, lifetime: 0 }).poolWidth).toBe(1);
    const runtime = new PoolRuntime();
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ poolWidth: 2 }),
    }).run(
      parsed({
        meta: { name: "pool" },
        nodes: [{ id: "p", type: "parallel", branches: ["a", "b", "c", "d", "e"] }],
      }),
    );
    expect(result.status).toBe("complete");
    expect(runtime.peak).toBe(2);
  });
});

describe("workflow engine", () => {
  it("executes in topological order and preserves report-only usage", async () => {
    const runtime = new FakeRuntime([[complete("one", 2, 3)], [complete("two", 5, 7)]]);
    const spec = parsed({
      meta: { name: "order" },
      nodes: [
        { id: "second", type: "agent", prompt: "after ${first}", depends_on: ["first"] },
        { id: "first", type: "agent", prompt: "first" },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned.map((request) => request.prompt)).toEqual(["first", "after one"]);
    expect(result.outputs).toEqual({ first: "one", second: "two" });
    expect(result.status).toBe("complete");
    expect(result.tokensIn).toBe(7);
    expect(result.tokensOut).toBe(10);
    expect(result.cacheReadTokens).toBe(14);
    expect(result.reasoningTokens).toBe(26);
  });

  it("counts a leaf that never reported usage as uncertain, not as a zero-cost measurement (#232)", async () => {
    const runtime = new FakeRuntime([
      [complete("measured", 100, 100)],
      [{ status: "complete", output: "unsure", usageUncertain: true }],
    ]);
    const spec = parsed({
      meta: { name: "uncertain" },
      nodes: [
        { id: "measured", type: "agent", prompt: "a" },
        { id: "unsure", type: "agent", prompt: "b" },
      ],
    });
    const budget = new Budget();
    const result = await new WorkflowEngine({ runtime, budget }).run(spec);
    expect(result.usageUncertainLeaves).toBe(1);
    expect(result.tokensIn).toBe(100);
    // If the uncertain leaf's zero counted toward the average, this would be
    // (100+100+0+0)/2 = 100 instead of (100+100)/1 = 200.
    expect(budget.estimatedLeafCost).toBe(200);
  });

  it("isolates an engine fault and keeps the next node running", async () => {
    const runtime = new FakeRuntime([[complete("ok")]]);
    const spec = parsed({
      meta: { name: "fault" },
      nodes: [
        { id: "bad", type: "agent", prompt: "bad" },
        { id: "good", type: "agent", prompt: "good" },
      ],
    });
    const engine = new WorkflowEngine({ runtime });
    engine.setStrategyForTest("agent", (_engine, node) => {
      return node.id === "bad" ? Promise.reject(new TypeError("boom")) : Promise.resolve("ok");
    });
    const result = await engine.run(spec);
    expect(result.outputs).toEqual({ bad: null, good: "ok" });
    expect(result.engineFaults).toBe(1);
    expect(result.faults[0]).toContain("TypeError: boom");
    expect(result.status).toBe("degraded");
  });

  it("treats required as runtime-inert", async () => {
    const runtime = new FakeRuntime([[{ status: "failed", output: "dead" }], [complete("useful")]]);
    const spec = parsed({
      meta: { name: "required-inert" },
      nodes: [
        { id: "dead", type: "agent", prompt: "x", required: true, retries: 0 },
        { id: "live", type: "agent", prompt: "y" },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("degraded");
    expect(result.nullCount).toBe(1);
  });

  it("logs each live sink failure without detaching it or changing the run", async () => {
    const logged: unknown[] = [];
    const runtime = new FakeRuntime([[complete("ok")]]);
    const spec = parsed({
      meta: { name: "sink" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({
      runtime,
      onEvent: () => {
        throw new Error("sink broke");
      },
      logError: (...args) => logged.push(args),
    }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
    expect(result.engineFaults).toBe(0);
    expect(logged).toHaveLength(2);
    expect((logged[0] as unknown[] | undefined)?.[1]).toBeInstanceOf(Error);
  });

  it("pauses before the next spawn after a soft token overrun", async () => {
    const runtime = new FakeRuntime([[complete("one", 7, 5)]]);
    const spec = parsed({
      meta: { name: "budget" },
      nodes: [
        { id: "a", type: "agent", prompt: "a" },
        { id: "b", type: "agent", prompt: "b" },
      ],
    });
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ tokenBudget: 10 }),
    }).run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget_exhausted");
    expect(result.capTrips).toBe(0);
  });

  it("charges engine budget from input and output but never reasoning", async () => {
    const budget = new Budget({ tokenBudget: 100 });
    const runtime = new FakeRuntime([[complete("done", 2, 3)]]);
    await new WorkflowEngine({ runtime, budget }).run(
      parsed({
        meta: { name: "reasoning-report-only" },
        nodes: [{ id: "a", type: "agent", prompt: "x" }],
      }),
    );
    expect(budget.tokensSpent).toBe(5);
    expect(budget.tokensRemaining).toBe(95);
  });

  it("replays a valid completion and never caches empty output", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new FakeRuntime([[complete("hit")], [complete("")], [complete("recovered")]]);
    const spec = parsed({
      meta: { name: "cache" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    const first = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(spec);
    const second = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(spec);
    expect(first.outputs).toEqual({ a: "hit" });
    expect(second.outputs).toEqual({ a: "hit" });
    expect(runtime.spawned).toHaveLength(1);
  });

  it("counts an empty-output agent retry as a leaf respawn (#247)", async () => {
    const runtime = new FakeRuntime([[complete("")], [complete("recovered")]]);
    const spec = parsed({
      meta: { name: "respawn-agent" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.a).toBe("recovered");
    expect((result as unknown as Record<string, unknown>).leafRespawns).toBe(1);
  });

  it("counts no leaf respawns when the first agent attempt succeeds (#247)", async () => {
    const runtime = new FakeRuntime([[complete("ok")]]);
    const spec = parsed({
      meta: { name: "no-respawn-agent" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect((result as unknown as Record<string, unknown>).leafRespawns).toBe(0);
  });

  it("counts an empty-output pipeline stage retry as a leaf respawn (#247)", async () => {
    const runtime = new FakeRuntime([[complete("")], [complete("done")]]);
    const spec = parsed({
      meta: { name: "respawn-pipeline" },
      nodes: [{ id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}" }] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual(["done"]);
    expect((result as unknown as Record<string, unknown>).leafRespawns).toBe(1);
  });

  it("reexecutes an empty scalar instead of caching it", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new FakeRuntime([[complete("")], [complete("fresh")]]);
    const spec = parsed({
      meta: { name: "empty-cache" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    const first = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(spec);
    const second = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(spec);
    expect(first.outputs.a).toBeNull();
    expect(second.outputs.a).toBe("fresh");
    expect(runtime.spawned).toHaveLength(2);
  });

  it("reports historical cached cost without charging a new leaf", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new FakeRuntime([[complete("hit", 9, 4)]]);
    const workflow = parsed({
      meta: { name: "cache-cost" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    await new WorkflowEngine({ runtime, cache, runId: "same" }).run(workflow);
    const replayBudget = new Budget({ tokenBudget: 100 });
    const replay = await new WorkflowEngine({
      runtime,
      cache,
      runId: "same",
      budget: replayBudget,
    }).run(workflow);
    expect(runtime.spawned).toHaveLength(1);
    expect(replay.tokensIn).toBe(9);
    expect(replay.tokensOut).toBe(4);
    expect(replay.cacheReadTokens).toBe(7);
    expect(replayBudget.tokensSpent).toBe(0);
  });

  it("namespaces cell hashes by workflow meta identity", async () => {
    const cache = new MemoryWorkflowCache();
    const runtime = new FakeRuntime([[complete("one")], [complete("two")]]);
    const one = parsed({
      meta: { name: "one", version: 1 },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const two = parsed({
      meta: { name: "two", version: 1 },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    await new WorkflowEngine({ runtime, cache, runId: "same" }).run(one);
    const result = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(two);
    expect(result.outputs.a).toBe("two");
    expect(runtime.spawned).toHaveLength(2);
  });

  it("runs parallel in declared order and refuses partial cache", async () => {
    const runtime = new FakeRuntime([[complete("A")], [complete("B")]]);
    const spec = parsed({
      meta: { name: "parallel" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b"] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual(["A", "B"]);
  });

  it("runs pipeline without a global stage barrier", async () => {
    const runtime = new FakeRuntime([
      [complete("a1")],
      [complete("b1")],
      [complete("a2")],
      [complete("b2")],
    ]);
    const spec = parsed({
      meta: { name: "pipeline" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a", "b"],
          stages: [{ prompt: "${item}-1" }, { prompt: "${stage.result}-2" }],
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual(["a2", "b2"]);
    expect(runtime.spawned.map((request) => request.prompt)).toEqual([
      "a-1",
      "b-1",
      "a1-2",
      "b1-2",
    ]);
  });

  it("lets a fast item enter stage two before a slow item finishes stage one", async () => {
    class TimedPipelineRuntime implements ChildRuntime {
      readonly events: string[] = [];
      private readonly prompts = new Map<string, string>();
      spawn(request: ChildSpawnRequest): string {
        const id = `timed-${String(this.prompts.size + 1)}`;
        this.prompts.set(id, request.prompt);
        this.events.push(`spawn:${request.prompt}`);
        return id;
      }
      async collect(id: string): Promise<ChildResult> {
        const prompt = this.prompts.get(id) ?? "missing";
        await new Promise((resolve) => setTimeout(resolve, prompt === "slow-1" ? 30 : 1));
        this.events.push(`complete:${prompt}`);
        return complete(prompt.replace("-1", "1").replace("-2", "2"));
      }
      steer(): void {}
      cancel(): void {}
    }
    const runtime = new TimedPipelineRuntime();
    const result = await new WorkflowEngine({ runtime }).run(
      parsed({
        meta: { name: "pipeline-overlap" },
        nodes: [
          {
            id: "p",
            type: "pipeline",
            items: ["slow", "fast"],
            stages: [{ prompt: "${item}-1" }, { prompt: "${stage.result}-2" }],
          },
        ],
      }),
    );
    expect(result.outputs.p).toEqual(["slow12", "fast12"]);
    expect(runtime.events.indexOf("spawn:fast1-2")).toBeLessThan(
      runtime.events.indexOf("complete:slow-1"),
    );
  });

  it("cancels work started before the pipeline deadline", async () => {
    class HangingRuntime implements ChildRuntime {
      readonly cancelled: string[] = [];
      spawn(): string {
        return "hanging";
      }
      collect(): Promise<ChildResult> {
        return new Promise(() => undefined);
      }
      steer(): void {}
      cancel(id: string): void {
        this.cancelled.push(id);
      }
    }
    const runtime = new HangingRuntime();
    const result = await new WorkflowEngine({ runtime, pipelineTimeoutSeconds: 0.01 }).run(
      parsed({
        meta: { name: "deadline" },
        nodes: [{ id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}" }] }],
      }),
    );
    expect(result.outputs.p).toEqual([null]);
    expect(result.faults.some((fault) => fault.includes("pipeline timeout"))).toBe(true);
    expect(runtime.cancelled).toEqual(["hanging"]);
  });

  it("checkpoint never spawns and an explicit falsy answer completes", async () => {
    const runtime = new FakeRuntime([]);
    const spec = parsed({
      meta: { name: "cp" },
      nodes: [{ id: "approve", type: "checkpoint", prompt: "Approve?" }],
    });
    const result = await new WorkflowEngine({ runtime, checkpointAnswers: { approve: false } }).run(
      spec,
    );
    expect(runtime.spawned).toHaveLength(0);
    expect(result.outputs.approve).toBe(false);
    expect(result.status).toBe("complete");
  });
});

describe("workflow service status", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  // #232: a leaf that never measured usage surfaces on workflow_status as
  // usage_uncertain_leaves — not silently folded into a zero-cost average.
  it("exposes usage_uncertain_leaves on workflow_status when a leaf never measured usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-service-uncertain-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const ownership = { fence: 0 as number, holder: "test", now: 1000 };
    const uncertainRuntime: ChildRuntime = {
      spawn: (): string => "leaf-1",
      collect: (): ChildResult => ({
        status: "complete",
        output: { answer: "ok" },
        usageUncertain: true,
      }),
      steer: (): void => undefined,
      cancel: (): void => undefined,
      installLeafSandbox: () => ({ dispose: (): void => undefined }),
    };
    const service = new WorkflowService({
      runtime: uncertainRuntime,
      store: {
        repository,
        locks,
        holder: "test",
        ttl: 900,
        ownershipOf: () => ownership,
        database: connection.database,
      },
    });
    const started = service.start(
      { meta: { name: "uncertain-status" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] },
      {},
    );
    if ("error" in started) throw new Error(started.error);
    const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(final.status).toBe("complete");
    expect(final.usage_uncertain_leaves).toBe(1);
    connection.close();
  });

  // #247: leaf_respawns must survive a checkpoint pause into the DURABLE
  // rollup — a cold reader (no live record) reads it back via
  // durableRollup, not resultView, and a resume that respawns nothing
  // keeps the prior count instead of resetting it.
  it("persists leaf_respawns in the durable rollup, cumulative across a resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-workflow-service-leaf-respawns-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const ownership = { fence: 0 as number, holder: "test", now: 1000 };
    const store = {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    };
    const runtime = new FakeRuntime([[complete("")], [complete("recovered")]]);
    const service = new WorkflowService({ runtime, store });
    const started = service.start(
      {
        meta: { name: "leaf-respawns-durable" },
        nodes: [
          { id: "a", type: "agent", prompt: "x" },
          { id: "cp", type: "checkpoint", prompt: "stop here" },
        ],
      },
      {},
    );
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect(paused.leaf_respawns).toBe(1);

    // A fresh service instance never called start() for this run — its
    // in-memory registry is empty, so status() must fall to durableRollup.
    const coldService = new WorkflowService({ runtime: new FakeRuntime([]), store });
    const cold = (await coldService.status(started.run_id)) as Record<string, unknown>;
    expect(cold.leaf_respawns).toBe(1);

    const resumed = coldService.start(
      null,
      {},
      {
        resumeRunId: started.run_id,
        checkpointAnswers: { cp: "go" },
      },
    );
    if ("error" in resumed) throw new Error(resumed.error);
    const finished = (await coldService.status(started.run_id, true)) as Record<string, unknown>;
    expect(finished.status).toBe("complete");

    const secondColdService = new WorkflowService({ runtime: new FakeRuntime([]), store });
    const durable = (await secondColdService.status(started.run_id)) as Record<string, unknown>;
    expect(durable.leaf_respawns).toBe(1);
    connection.close();
  });
});

describe("budget average after a seeded resume (#285)", () => {
  // #280/#232 changed estimatedLeafCost from tokensSpent/measuredLeaves to
  // (measuredInput + measuredOutput)/measuredLeaves. tokensSpent (the hard
  // ceiling) includes the constructor seed (tokensIn/tokensOut — how the
  // durable resume in service.ts replays prior spend); the average's own
  // accumulators do not. This pins that as the intended behavior: the
  // seed counts toward the ceiling, never toward the per-leaf average.
  it("keeps the seeded spend out of the average but in the ceiling once a leaf is measured", () => {
    const budget = new Budget({ tokenBudget: 10_000, tokensIn: 5000, tokensOut: 1000 });
    budget.chargeTokens(200, 0);
    expect(budget.estimatedLeafCost).toBe(200);
    expect(budget.tokensSpent).toBe(6200);
    // remaining 3800 / cost 200 — never remaining / measuredLeaves (which
    // would give 0, the pre-#232 behavior with the old formula's average).
    expect(budget.affordableLeaves()).toBe(19);
  });

  it("falls back to the default estimate when no leaf was measured, even with a seed", () => {
    const budget = new Budget({ tokenBudget: 10_000, tokensIn: 5000, tokensOut: 1000 });
    expect(budget.estimatedLeafCost).toBe(ESTIMATED_TOKENS_PER_LEAF);
    expect(budget.tokensSpent).toBe(6000);
    // remaining 4000 / default cost 2000.
    expect(budget.affordableLeaves()).toBe(2);
  });
});
