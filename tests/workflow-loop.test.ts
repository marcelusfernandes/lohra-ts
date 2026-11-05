// Issue #980 (S3 do épico #976): o nó `loop` repete um corpo até um predicado,
// com `max_rounds` obrigatório. O que prende:
//   - para na primeira rodada em que `until` vale, com `{last, rounds,
//     until_met:true}`; a rodada r vê `${round}` e `${so_far}`, e o `until` vê
//     `${last}` (e `round`/`so_far` como a rodada os viu);
//   - no teto a saída é `{…, until_met:false}`, com um fault que nomeia o nó e o
//     teto (o run termina `degraded`, nunca em silêncio);
//   - rodada morta dá fault e saída null; pausa ou cancel no meio dá null SEM
//     fault extra, e um resume reaproveita as rodadas já feitas sem spawn;
//   - `checkFanout(max_rounds)` antes da rodada 0 (`FanoutRejected` conta em
//     `cap_trips`) e um `items` por rodada;
//   - uma célula por rodada (hash pinado), com a rodada na identidade; `until` e
//     `max_rounds` fora dela;
//   - a guarda de upstream null para os caminhos do `until` que leem nós upstream.
// O ledger e o preview ficam em `tests/workflow-cache-preview-flow.test.ts`.
import { describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { Budget } from "../src/workflow/budget.js";
import { contentHash, MemoryWorkflowCache, type CacheLookup } from "../src/workflow/cache.js";
import type { RunControl, WorkflowEvent } from "../src/workflow/engine-contract.js";
import { idleRunControl } from "../src/workflow/engine-options.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { validateSpec } from "../src/workflow/schema.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { Node, WorkflowSpec } from "../src/workflow/types.js";

const NAME = "loop-run";
const DEAD = Symbol("dead leaf");

/** Hands out the scripted outputs in order; a `failed` for `DEAD` or once the script runs dry. */
class ScriptedRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  readonly collected: ChildCollectOptions[] = [];
  private readonly pending: unknown[];

  constructor(
    outputs: readonly unknown[] = [],
    private readonly afterCollect: (count: number) => void = () => undefined,
  ) {
    this.pending = [...outputs];
  }

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }

  collect(_id: string, options: ChildCollectOptions): ChildResult {
    this.collected.push(options);
    const next = this.pending.shift();
    this.afterCollect(this.collected.length);
    if (next === undefined || next === DEAD) return { status: "failed", output: "dead leaf" };
    const tokens = usage({ inputTokens: 1, outputTokens: 1 });
    return { status: "complete", output: next, usage: tokens, provider: "stub", model: "canned" };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

interface Lookup {
  readonly hash: string;
  readonly nodeId: string | undefined;
  readonly hit: boolean;
}

/** A cache that remembers every lookup and every write, and under which owner. */
class RecordingCache extends MemoryWorkflowCache {
  readonly gets: Lookup[] = [];
  readonly puts: { readonly hash: string; readonly nodeId: string; readonly output: unknown }[] =
    [];

  override get(runId: string, hash: string, nodeId?: string): CacheLookup {
    const found = super.get(runId, hash, nodeId);
    this.gets.push({ hash, nodeId, hit: found.hit });
    return found;
  }

  override put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Parameters<MemoryWorkflowCache["put"]>[4],
  ): boolean {
    this.puts.push({ hash, nodeId, output });
    return super.put(runId, hash, nodeId, output, cost);
  }

  of(nodeId: string): { gets: Lookup[]; puts: RecordingCache["puts"] } {
    return {
      gets: this.gets.filter((entry) => entry.nodeId === nodeId),
      puts: this.puts.filter((entry) => entry.nodeId === nodeId),
    };
  }
}

function spec(
  nodes: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): WorkflowSpec {
  const result = validateSpec({ meta: { name: NAME }, nodes, ...extra });
  if ("issues" in result) throw new Error(result.message);
  return result;
}

interface Options {
  readonly cache?: MemoryWorkflowCache;
  readonly budget?: Budget;
  readonly control?: RunControl;
  readonly nodeScope?: readonly string[];
  readonly events?: WorkflowEvent[];
}

function engineFor(runtime: ScriptedRuntime, options: Options): WorkflowEngine {
  return new WorkflowEngine({
    runtime,
    runId: "run",
    logError: () => undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.control === undefined ? {} : { control: options.control }),
    ...(options.nodeScope === undefined ? {} : { nodeScope: options.nodeScope }),
    ...(options.events === undefined
      ? {}
      : { onEvent: (event: WorkflowEvent) => options.events?.push(event) }),
  });
}

const run = (
  runtime: ScriptedRuntime,
  workflow: WorkflowSpec,
  args: Record<string, unknown> = {},
  options: Options = {},
) => engineFor(runtime, options).run(workflow, args);

const SCORE_8 = { gte: { path: "${last.score}", n: 8 } };

/** Improves `args.text` until a note field reaches 8; `round` and `so_far` are in the prompt. */
const refine = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "refine",
  type: "loop",
  body: { prompt: "Improve ${args.text} (round ${round}, so far ${so_far})" },
  until: SCORE_8,
  max_rounds: 3,
  ...extra,
});

const workflowOf = (extra: Record<string, unknown> = {}): WorkflowSpec => spec([refine(extra)]);

const ARGS = { text: "draft" };
const score = (value: number): { score: number } => ({ score: value });

describe("repeats the body until `until` holds (#980)", () => {
  it("stops on the first round where it holds, returning {last, rounds, until_met:true}", async () => {
    const runtime = new ScriptedRuntime([score(5), score(7), score(9), score(10)]);
    const result = await run(runtime, workflowOf({ max_rounds: 5 }), ARGS);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 3, until_met: true });
    expect(Object.isFrozen(result.outputs.refine)).toBe(true);
    expect(runtime.spawned).toHaveLength(3);
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
    expect(result.nullCount).toBe(0);
  });

  it("holding on round 0 is one round and one leaf", async () => {
    const runtime = new ScriptedRuntime([score(9), score(9)]);
    const result = await run(runtime, workflowOf(), ARGS);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 1, until_met: true });
    expect(runtime.spawned).toHaveLength(1);
  });

  it("round r sees ${round} and ${so_far}: the outputs of the rounds before it", async () => {
    const runtime = new ScriptedRuntime([score(1), score(2), score(9)]);
    await run(runtime, workflowOf(), ARGS);
    expect(runtime.spawned.map((request) => request.prompt)).toEqual([
      "Improve draft (round 0, so far [])",
      'Improve draft (round 1, so far [{"score":1}])',
      'Improve draft (round 2, so far [{"score":1},{"score":2}])',
    ]);
  });

  it("`until` sees ${last}, the output of the round that just ran", async () => {
    const runtime = new ScriptedRuntime([
      { verdict: "revise" },
      { verdict: "revise" },
      { verdict: "ok" },
      { verdict: "ok" },
    ]);
    const result = await run(
      runtime,
      workflowOf({ until: { field_equals: { path: "${last.verdict}", value: "ok" } } }),
      ARGS,
    );
    expect(result.outputs.refine).toEqual({ last: { verdict: "ok" }, rounds: 3, until_met: true });
  });

  it("`until` reads a plain string output through ${last} itself", async () => {
    const result = await run(
      new ScriptedRuntime(["more", "done"]),
      workflowOf({ until: { field_equals: { path: "${last}", value: "done" } } }),
      ARGS,
    );
    expect(result.outputs.refine).toEqual({ last: "done", rounds: 2, until_met: true });
  });

  it("`until` sees ${round} and ${so_far} as the round saw them", async () => {
    const byRound = await run(
      new ScriptedRuntime([score(1), score(1), score(1)]),
      workflowOf({ until: { gte: { path: "${round}", n: 1 } } }),
      ARGS,
    );
    expect(byRound.outputs.refine).toEqual({ last: score(1), rounds: 2, until_met: true });

    const bySoFar = await run(
      new ScriptedRuntime([score(1), score(1), score(1)]),
      workflowOf({ until: { count_gte: { path: "${so_far}", n: 2 } } }),
      ARGS,
    );
    expect(bySoFar.outputs.refine).toEqual({ last: score(1), rounds: 3, until_met: true });
  });

  it("`until` may read an upstream node and args, not only the round", async () => {
    const workflow = spec([
      { id: "scan", type: "agent", prompt: "scan" },
      refine({ until: { field_true: { path: "${scan.ready}" } } }),
    ]);
    const runtime = new ScriptedRuntime([{ ready: true }, score(1)]);
    const result = await run(runtime, workflow, ARGS);
    expect(result.outputs.refine).toEqual({ last: score(1), rounds: 1, until_met: true });

    const byArg = await run(
      new ScriptedRuntime([score(1)]),
      workflowOf({ until: { field_equals: { path: "${args.stop}", value: true } } }),
      { ...ARGS, stop: true },
    );
    expect(byArg.outputs.refine).toMatchObject({ rounds: 1, until_met: true });
  });

  it("downstream nodes read the pieces with ${refine.last} and ${refine.rounds}", async () => {
    const workflow = spec([
      refine(),
      { id: "report", type: "agent", prompt: "After ${refine.rounds}: ${refine.last.score}" },
    ]);
    const runtime = new ScriptedRuntime([score(9), "reported"]);
    const result = await run(runtime, workflow, ARGS);
    expect(runtime.spawned[1]?.prompt).toBe("After 1: 9");
    expect(result.outputs.report).toBe("reported");
  });
});

describe("the cap ends the loop with a named fault (#980)", () => {
  it("returns {last, rounds: max_rounds, until_met:false} and a fault naming the node and the cap", async () => {
    const runtime = new ScriptedRuntime([score(1), score(2), score(3), score(4)]);
    const result = await run(runtime, workflowOf(), ARGS);
    expect(result.outputs.refine).toEqual({ last: score(3), rounds: 3, until_met: false });
    expect(runtime.spawned).toHaveLength(3);
    expect(result.faults).toEqual(["refine: reached max_rounds (3) without 'until' holding"]);
    expect(result.status).toBe("degraded");
    expect(result.nullCount).toBe(0);
  });

  it("max_rounds 1 is one leaf, and a miss is the cap", async () => {
    const runtime = new ScriptedRuntime([score(1), score(9)]);
    const result = await run(runtime, workflowOf({ max_rounds: 1 }), ARGS);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.refine).toEqual({ last: score(1), rounds: 1, until_met: false });
    expect(result.faults).toEqual(["refine: reached max_rounds (1) without 'until' holding"]);
  });

  it("never spawns more than max_rounds leaves, even at the highest cap", async () => {
    const runtime = new ScriptedRuntime(Array.from({ length: 40 }, () => score(1)));
    const result = await run(runtime, workflowOf({ max_rounds: 16 }), ARGS);
    expect(runtime.spawned).toHaveLength(16);
    expect(result.outputs.refine).toMatchObject({ rounds: 16, until_met: false });
  });

  it("holding on the very last round is not a cap hit", async () => {
    const runtime = new ScriptedRuntime([score(1), score(1), score(9)]);
    const result = await run(runtime, workflowOf(), ARGS);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 3, until_met: true });
    expect(result.faults).toEqual([]);
  });
});

describe("a round that does not produce an output (#980)", () => {
  it("a dead round is a fault that names the round, the node is null and no later round runs", async () => {
    const runtime = new ScriptedRuntime([score(1), DEAD, score(9)]);
    const result = await run(runtime, workflowOf(), ARGS);
    expect(result.outputs.refine).toBeNull();
    expect(runtime.spawned).toHaveLength(2);
    expect(result.faults).toContain("refine: round 1 dead");
    expect(result.faults.filter((fault) => fault.includes("round"))).toEqual([
      "refine: round 1 dead",
    ]);
    expect(result.nullCount).toBe(1);
    expect(result.status).toBe("failed");
  });

  it("keeps the rounds that did finish, so a resume spawns only from the dead one", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), DEAD]), workflowOf(), ARGS, { cache });
    expect(cache.of("refine").puts.map((entry) => entry.output)).toEqual([score(1)]);

    const second = new ScriptedRuntime([score(9)]);
    const result = await run(second, workflowOf(), ARGS, { cache });
    expect(second.spawned).toHaveLength(1);
    expect(second.spawned[0]?.causalContext.attempt).toBe(1);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 2, until_met: true });
  });

  it("an empty answer is a fault, not a silent success, and it is never cached", async () => {
    const cache = new RecordingCache();
    const result = await run(new ScriptedRuntime([score(1), ""]), workflowOf(), ARGS, { cache });
    expect(result.outputs.refine).toBeNull();
    expect(result.faults).toEqual(["refine: round 1 returned an empty output"]);
    expect(cache.of("refine").puts).toHaveLength(1);
  });

  it("the body's retries respawn a dead leaf inside the round, under the same causal step", async () => {
    const runtime = new ScriptedRuntime([DEAD, score(9)]);
    const result = await run(
      runtime,
      workflowOf({ body: { prompt: "Improve ${args.text}", retries: 1 } }),
      ARGS,
    );
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 1, until_met: true });
    expect(runtime.spawned).toHaveLength(2);
    expect(result.leafRespawns).toBe(1);
    for (const request of runtime.spawned) {
      expect(request.causalContext).toMatchObject({ role: "loop.round", attempt: 0 });
    }
  });

  it("a body prompt that reads a dead upstream is upstream null, and nothing spawns", async () => {
    const workflow = spec([
      { id: "scan", type: "agent", prompt: "scan" },
      refine({ body: { prompt: "Improve ${scan.text}" } }),
    ]);
    const runtime = new ScriptedRuntime([DEAD, score(9)]);
    const result = await run(runtime, workflow, ARGS);
    expect(result.outputs.refine).toBeNull();
    expect(result.faults.filter((fault) => fault.startsWith("refine:"))).toEqual([
      "refine: upstream null",
    ]);
    expect(runtime.spawned).toHaveLength(1);
  });
});

describe("pause, cancel and resume (#980)", () => {
  it("a pause after round 1 ends the node null with no fault of its own", async () => {
    const control = idleRunControl();
    const runtime = new ScriptedRuntime([score(1), score(2), score(9)], (count) => {
      if (count === 2) control.paused = true;
    });
    const result = await run(runtime, workflowOf({ max_rounds: 5 }), ARGS, { control });
    expect(result.outputs.refine).toBeNull();
    expect(runtime.spawned).toHaveLength(2);
    expect(result.faults).toEqual([]);
    expect(result.status).toBe("paused");
  });

  it("a cancel in the middle is null without a fault either", async () => {
    const control = idleRunControl();
    const runtime = new ScriptedRuntime([score(1), score(9)], (count) => {
      if (count === 1) control.cancelled = true;
    });
    const result = await run(runtime, workflowOf(), ARGS, { control });
    expect(result.outputs.refine).toBeNull();
    expect(runtime.spawned).toHaveLength(1);
    expect(result.faults).toEqual([]);
    expect(result.status).toBe("cancelled");
  });

  it("a round whose leaf died BECAUSE the run paused is not also a 'dead round'", async () => {
    const control = idleRunControl();
    const runtime = new ScriptedRuntime([score(1), DEAD], (count) => {
      if (count === 2) control.paused = true;
    });
    const result = await run(runtime, workflowOf(), ARGS, { control });
    expect(result.outputs.refine).toBeNull();
    expect(result.faults.filter((fault) => fault.startsWith("refine: round"))).toEqual([]);
  });

  it("a resume after a pause at round k reuses rounds 0..k-1 without a spawn", async () => {
    const cache = new RecordingCache();
    const control = idleRunControl();
    const first = new ScriptedRuntime([score(1), score(2), score(3)], (count) => {
      if (count === 3) control.paused = true;
    });
    await run(first, workflowOf({ max_rounds: 6 }), ARGS, { cache, control });
    expect(first.spawned).toHaveLength(3);
    expect(cache.of("refine").puts).toHaveLength(3);

    const second = new ScriptedRuntime([score(9)]);
    const result = await run(second, workflowOf({ max_rounds: 6 }), ARGS, { cache });
    expect(second.spawned).toHaveLength(1);
    expect(second.spawned[0]?.causalContext).toMatchObject({ role: "loop.round", attempt: 3 });
    expect(second.spawned[0]?.prompt).toBe(
      'Improve draft (round 3, so far [{"score":1},{"score":2},{"score":3}])',
    );
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 4, until_met: true });
    expect(
      cache
        .of("refine")
        .gets.slice(-4)
        .map((entry) => entry.hit),
    ).toEqual([true, true, true, false]);
  });

  it("a resume of a loop that already finished replays every round and spawns nothing", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), score(9)]), workflowOf(), ARGS, { cache });
    const second = new ScriptedRuntime();
    const result = await run(second, workflowOf(), ARGS, { cache });
    expect(second.spawned).toHaveLength(0);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 2, until_met: true });
    expect(result.faults).toEqual([]);
  });

  it("a replayed cap hit says so again: the fault belongs to the outcome, not to the spawn", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), score(1), score(1)]), workflowOf(), ARGS, { cache });
    const second = new ScriptedRuntime();
    const result = await run(second, workflowOf(), ARGS, { cache });
    expect(second.spawned).toHaveLength(0);
    expect(result.outputs.refine).toEqual({ last: score(1), rounds: 3, until_met: false });
    expect(result.faults).toEqual(["refine: reached max_rounds (3) without 'until' holding"]);
  });

  it("a run whose token budget runs out mid-loop pauses with the finished rounds cached", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([score(1), score(2), score(9)]);
    const result = await run(runtime, workflowOf({ max_rounds: 5 }), ARGS, {
      cache,
      budget: new Budget({ tokenBudget: 2 }),
    });
    expect(result.outputs.refine).toBeNull();
    expect(runtime.spawned).toHaveLength(1);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget_exhausted");
    expect(result.faults.filter((fault) => fault.startsWith("refine: round"))).toEqual([]);
    expect(cache.of("refine").puts).toHaveLength(1);
  });
});

describe("fan-out, progress and the budget gate (#980)", () => {
  it("checkFanout(max_rounds) runs before round 0: a rejected cap spawns nothing and counts a cap trip", async () => {
    const runtime = new ScriptedRuntime([score(9)]);
    const result = await run(runtime, workflowOf({ max_rounds: 3 }), ARGS, {
      budget: new Budget({ maxFanout: 2 }),
    });
    expect(runtime.spawned).toHaveLength(0);
    expect(result.capTrips).toBe(1);
    expect(result.outputs.refine).toBeNull();
    expect(result.faults).toEqual(["refine: fan-out of 3 exceeds max_fanout 2"]);
  });

  it("the lifetime counts too, and a cap exactly at the limit still runs", async () => {
    const runtime = new ScriptedRuntime([score(9)]);
    const rejected = await run(runtime, workflowOf({ max_rounds: 3 }), ARGS, {
      budget: new Budget({ lifetime: 2 }),
    });
    expect(runtime.spawned).toHaveLength(0);
    expect(rejected.capTrips).toBe(1);
    expect(rejected.faults.join("\n")).toMatch(/^refine: .*lifetime/mu);

    const fits = await run(new ScriptedRuntime([score(9)]), workflowOf({ max_rounds: 3 }), ARGS, {
      budget: new Budget({ maxFanout: 3, lifetime: 3 }),
    });
    expect(fits.capTrips).toBe(0);
    expect(fits.outputs.refine).toMatchObject({ until_met: true });
  });

  it("the gate is the declared cap, not the rounds that happen to run: holding on round 0 still trips a low fan-out", async () => {
    const runtime = new ScriptedRuntime([score(9)]);
    const result = await run(runtime, workflowOf({ max_rounds: 8 }), ARGS, {
      budget: new Budget({ maxFanout: 4 }),
    });
    expect(runtime.spawned).toHaveLength(0);
    expect(result.capTrips).toBe(1);
  });

  it("emits `items {done, total}` at the start and after every round, replayed ones included", async () => {
    const events: WorkflowEvent[] = [];
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), score(1), score(9)]), workflowOf(), ARGS, {
      events,
      cache,
    });
    const progress = (): string[] =>
      events
        .filter((event) => event.kind === "items")
        .map((event) => `${event.nodeId}:${String(event.done)}/${String(event.total)}`);
    expect(progress()).toEqual(["refine:0/3", "refine:1/3", "refine:2/3", "refine:3/3"]);

    events.length = 0;
    await run(new ScriptedRuntime(), workflowOf(), ARGS, { events, cache });
    expect(progress()).toEqual(["refine:0/3", "refine:1/3", "refine:2/3", "refine:3/3"]);
  });

  it("reports only the rounds that ran: none for the ones after `until` held", async () => {
    const events: WorkflowEvent[] = [];
    await run(new ScriptedRuntime([score(9)]), workflowOf(), ARGS, { events });
    const items = events.filter((event) => event.kind === "items");
    expect(items.map((event) => `${String(event.done)}/${String(event.total)}`)).toEqual([
      "0/3",
      "1/3",
    ]);
  });
});

describe("one cell per round (#980)", () => {
  it("stores each finished round under the node, with a pinned identity that carries the round", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), score(9)]), workflowOf(), ARGS, { cache });
    expect(cache.of("refine").puts).toEqual([
      {
        hash: contentHash(
          NAME,
          null,
          "refine",
          "loop",
          0,
          "Improve draft (round 0, so far [])",
          null,
        ),
        nodeId: "refine",
        output: score(1),
      },
      {
        hash: contentHash(
          NAME,
          null,
          "refine",
          "loop",
          1,
          'Improve draft (round 1, so far [{"score":1}])',
          null,
        ),
        nodeId: "refine",
        output: score(9),
      },
    ]);
  });

  it("the round is part of the identity: a body that never reads the state is still one cell per round", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([score(1), score(2), score(3)]);
    const result = await run(runtime, workflowOf({ body: { prompt: "Improve the text" } }), ARGS, {
      cache,
    });
    const hashes = cache.of("refine").puts.map((entry) => entry.hash);
    expect(new Set(hashes).size).toBe(3);
    expect(runtime.spawned).toHaveLength(3);
    expect(result.outputs.refine).toMatchObject({ rounds: 3 });
  });

  it("`until` and `max_rounds` are not part of a cell: changing them on a resume reuses the finished rounds", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(1), score(2)]), workflowOf({ max_rounds: 2 }), ARGS, {
      cache,
    });

    const second = new ScriptedRuntime([score(9)]);
    const result = await run(
      second,
      workflowOf({ max_rounds: 4, until: { gte: { path: "${last.score}", n: 9 } } }),
      ARGS,
      { cache },
    );
    expect(second.spawned).toHaveLength(1);
    expect(second.spawned[0]?.causalContext.attempt).toBe(2);
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 3, until_met: true });
  });

  it("a stricter `until` on a resume keeps going from the replayed rounds", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(5), score(9)]), workflowOf(), ARGS, { cache });
    const second = new ScriptedRuntime([score(10)]);
    const result = await run(
      second,
      workflowOf({ until: { gte: { path: "${last.score}", n: 10 } } }),
      ARGS,
      { cache },
    );
    expect(second.spawned).toHaveLength(1);
    expect(result.outputs.refine).toEqual({ last: score(10), rounds: 3, until_met: true });
  });

  it("another body prompt is another cell: nothing is replayed", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(9)]), workflowOf(), ARGS, { cache });
    const second = new ScriptedRuntime([score(9)]);
    await run(second, workflowOf(), { text: "another draft" }, { cache });
    expect(second.spawned).toHaveLength(1);
  });

  it("a knob in the body is part of the cell", async () => {
    const cache = new RecordingCache();
    const body = (iterations: number) => ({
      body: { prompt: "Improve ${args.text}", max_iterations: iterations },
    });
    await run(new ScriptedRuntime([score(9)]), workflowOf(body(7)), ARGS, { cache });
    const second = new ScriptedRuntime([score(9)]);
    await run(second, workflowOf(body(8)), ARGS, { cache });
    expect(second.spawned).toHaveLength(1);
    const stored = cache.of("refine").puts;
    expect(stored).toHaveLength(2);
    expect(stored[0]?.hash).not.toBe(stored[1]?.hash);
  });

  it("node-level routing is part of the cell and reaches every round's leaf", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([score(1), score(9)]);
    await run(runtime, workflowOf({ provider: "p" }), ARGS, { cache });
    expect(runtime.spawned.map((request) => request.provider)).toEqual(["p", "p"]);
    expect(cache.of("refine").puts[0]?.hash).toBe(
      contentHash(
        NAME,
        null,
        "refine",
        "loop",
        0,
        "Improve draft (round 0, so far [])",
        null,
        null,
        null,
        "p",
      ),
    );
  });

  it("a nested loop keys its cells under the scope: <scope>.<id>", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime([score(9)]), workflowOf(), ARGS, {
      cache,
      nodeScope: ["sub"],
    });
    expect(cache.puts.map((entry) => entry.nodeId)).toEqual(["sub.refine"]);
    expect(cache.puts[0]?.hash).toBe(
      contentHash(
        NAME,
        null,
        "sub",
        "refine",
        "loop",
        0,
        "Improve draft (round 0, so far [])",
        null,
      ),
    );
  });
});

describe("the leaf of each round (#980)", () => {
  it("carries role loop.round, the node's path and the round as attempt", async () => {
    const runtime = new ScriptedRuntime([score(1), score(2), score(3)]);
    await run(runtime, workflowOf(), ARGS);
    expect(runtime.spawned.map((request) => request.causalContext)).toMatchObject([
      { role: "loop.round", nodePath: ["refine"], attempt: 0 },
      { role: "loop.round", nodePath: ["refine"], attempt: 1 },
      { role: "loop.round", nodePath: ["refine"], attempt: 2 },
    ]);
  });

  it("max_iterations and timeout of the body are the leaf's, on every round", async () => {
    const runtime = new ScriptedRuntime([score(1), score(9)]);
    await run(
      runtime,
      workflowOf({ body: { prompt: "go ${round}", max_iterations: 7, timeout: 33 } }),
      ARGS,
    );
    expect(runtime.spawned.map((request) => request.maxIterations)).toEqual([7, 7]);
    expect(runtime.collected.map((options) => options.timeoutSeconds)).toEqual([33, 33]);
  });

  it("a body schema_ref forces a tool_less leaf into the named schema", async () => {
    const schema = {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
    };
    const workflow = spec(
      [refine({ body: { prompt: "go", tool_less: true, schema_ref: "DRAFT" } })],
      { schemas: { DRAFT: schema } },
    );
    const runtime = new ScriptedRuntime([score(9)]);
    const result = await run(runtime, workflow, ARGS);
    expect(runtime.spawned[0]?.forcedTool).toMatchObject({ name: "StructuredOutput", schema });
    expect(result.outputs.refine).toEqual({ last: score(9), rounds: 1, until_met: true });
  });
});

describe("upstream null guard on `until` (#980)", () => {
  const withScan = (until: unknown, extra: Record<string, unknown> = {}): WorkflowSpec =>
    spec([{ id: "scan", type: "agent", prompt: "scan" }, refine({ until, ...extra })]);

  it("an `until` path whose ROOT is a dead upstream fails the node before any round runs", async () => {
    const runtime = new ScriptedRuntime([DEAD, score(9)]);
    const result = await run(runtime, withScan({ field_true: { path: "${scan.ready}" } }), ARGS);
    expect(result.outputs.scan).toBeNull();
    expect(result.outputs.refine).toBeNull();
    expect(result.faults.filter((fault) => fault.startsWith("refine:"))).toEqual([
      "refine: upstream null",
    ]);
    expect(runtime.spawned).toHaveLength(1);
  });

  it("looks inside `not` and in every path the predicate carries", async () => {
    const result = await run(
      new ScriptedRuntime([DEAD]),
      withScan({ not: { of: { field_true: { path: "${scan.ready}" } } } }),
      ARGS,
    );
    expect(result.faults.filter((fault) => fault.startsWith("refine:"))).toEqual([
      "refine: upstream null",
    ]);
  });

  it("is named before the cap is checked: a dead upstream is not also a cap trip", async () => {
    const result = await run(
      new ScriptedRuntime([DEAD]),
      withScan({ field_true: { path: "${scan.ready}" } }),
      ARGS,
      { budget: new Budget({ maxFanout: 1 }) },
    );
    expect(result.capTrips).toBe(0);
    expect(result.faults.filter((fault) => fault.startsWith("refine:"))).toEqual([
      "refine: upstream null",
    ]);
  });

  it("only the ROOT counts: a present upstream that lacks the field is a value, so the loop runs to the cap", async () => {
    const runtime = new ScriptedRuntime([{ other: 1 }, score(1), score(1), score(1)]);
    const result = await run(runtime, withScan({ field_true: { path: "${scan.ready}" } }), ARGS);
    expect(result.faults).toEqual(["refine: reached max_rounds (3) without 'until' holding"]);
    expect(result.outputs.refine).toMatchObject({ rounds: 3, until_met: false });
  });

  it("the round's own locals and args are never upstream, even for a field that is not there", async () => {
    const runtime = new ScriptedRuntime([score(1), score(1), score(1)]);
    const result = await run(
      runtime,
      workflowOf({ until: { field_true: { path: "${args.never_given}" } } }),
      ARGS,
    );
    expect(result.faults).toEqual(["refine: reached max_rounds (3) without 'until' holding"]);
    expect(runtime.spawned).toHaveLength(3);
  });
});

describe("a node the validator would have refused (#980)", () => {
  it("is an engine fault with a cause, never a silent null", async () => {
    const node = new Node("refine", "loop", { body: { prompt: "x" }, until: SCORE_8 });
    const workflow = new WorkflowSpec({
      meta: { name: NAME },
      inputs: {},
      schemas: {},
      nodes: [node],
    });
    const result = await run(new ScriptedRuntime([score(9)]), workflow);
    expect(result.outputs.refine).toBeNull();
    expect(result.engineFaults).toBe(1);
    expect(result.faults.join("\n")).toContain("loop 'refine' has no valid");
  });
});
