// Issue #977 (S1, épico #976): a costura de estratégias de nó fora de
// `engine.ts`. `FLOW_STRATEGIES` carrega as estratégias que recebem um
// `FlowDeps` em vez do engine inteiro; `completeness_check` e `checkpoint`
// migram para lá como prova, com os hashes de célula INALTERADOS (um cache
// durável gravado antes da migração tem de continuar acertando). O restante
// do arquivo prova que o `FlowDeps` basta para escrever os nós S2 (switch),
// S3 (loop), S4 (escalate) e S6 (call) sem tocar `engine.ts` de novo.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { Budget } from "../src/workflow/budget.js";
import { contentHash, MemoryWorkflowCache } from "../src/workflow/cache.js";
import {
  CACHE_MISS,
  type RunControl,
  type WorkflowEvent,
} from "../src/workflow/engine-contract.js";
import { idleRunControl } from "../src/workflow/engine-options.js";
import { resolveCheckpoint, routingIdentity } from "../src/workflow/engine-utils.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import {
  FLOW_STRATEGIES,
  type FlowDeps,
  type FlowStrategy,
} from "../src/workflow/flow-strategies.js";
import { makeBodyLeafRunner } from "../src/workflow/leaf-options.js";
import { NODE_TYPES } from "../src/workflow/nodes.js";
import { evaluatePredicate } from "../src/workflow/predicates.js";
import { readPath } from "../src/workflow/refs.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { NODE_VALIDATORS, validateGate } from "../src/workflow/schema-nodes.js";
import { validateSpec } from "../src/workflow/schema.js";
import { Node, type SpecIssue, type WorkflowSpec } from "../src/workflow/types.js";

const NAME = "flow-seam";
const DEAD = Symbol("dead leaf");

/** Hands out the scripted outputs in order; a `failed` for `DEAD` or once the script runs dry. */
class ScriptedRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  private readonly pending: unknown[];

  constructor(outputs: readonly unknown[] = []) {
    this.pending = [...outputs];
  }

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }

  collect(_id: string, _options: ChildCollectOptions): ChildResult {
    const next = this.pending.shift();
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

/** A cache that remembers every hash the engine read or wrote, and under which owner. */
class RecordingCache extends MemoryWorkflowCache {
  readonly gets: { readonly hash: string; readonly nodeId: string | undefined }[] = [];
  readonly puts: { readonly hash: string; readonly nodeId: string; readonly output: unknown }[] =
    [];

  override get(runId: string, hash: string, nodeId?: string) {
    this.gets.push({ hash, nodeId });
    return super.get(runId, hash, nodeId);
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
}

function parsed(raw: unknown): WorkflowSpec {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

const spec = (nodes: readonly Record<string, unknown>[]): WorkflowSpec =>
  parsed({ meta: { name: NAME }, nodes });

interface Options {
  readonly runtime?: ScriptedRuntime;
  readonly cache?: MemoryWorkflowCache;
  readonly control?: RunControl;
  readonly budget?: Budget;
  readonly nodeScope?: readonly string[];
  readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
  readonly events?: WorkflowEvent[];
}

function engineFor(options: Options): WorkflowEngine {
  return new WorkflowEngine({
    runtime: options.runtime ?? new ScriptedRuntime(),
    runId: "run",
    logError: () => undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.control === undefined ? {} : { control: options.control }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.nodeScope === undefined ? {} : { nodeScope: options.nodeScope }),
    ...(options.checkpointAnswers === undefined
      ? {}
      : { checkpointAnswers: options.checkpointAnswers }),
    ...(options.events === undefined
      ? {}
      : { onEvent: (event: WorkflowEvent) => options.events?.push(event) }),
  });
}

/** One `agent` node whose strategy is replaced by `strategy`: it gets deps, never the engine. */
function runWith(
  strategy: FlowStrategy,
  options: Options & { readonly args?: Readonly<Record<string, unknown>> } = {},
) {
  const engine = engineFor(options);
  engine.setFlowStrategyForTest("agent", strategy);
  return engine.run(spec([{ id: "n", type: "agent", prompt: "x" }]), options.args ?? {});
}

describe("FLOW_STRATEGIES (#977)", () => {
  // #979 (S2): `switch` is the first node a later issue adds through the table; #980 (S3): `loop`.
  it("carries completeness_check, checkpoint, loop and switch, frozen, and only for types the spec accepts", () => {
    expect(Object.keys(FLOW_STRATEGIES).sort()).toEqual([
      "checkpoint",
      "completeness_check",
      "loop",
      "switch",
    ]);
    expect(Object.isFrozen(FLOW_STRATEGIES)).toBe(true);
    for (const type of Object.keys(FLOW_STRATEGIES)) expect(NODE_TYPES.has(type)).toBe(true);
  });

  it("NODE_TYPES is the ten types the seam started with plus the nodes added through it: switch, loop", () => {
    expect([...NODE_TYPES].sort().join(",")).toBe(
      "agent,checkpoint,completeness_check,gate,judge_panel,loop,loop_until_dry,parallel,pipeline,switch,verify,workflow",
    );
  });

  it("no longer lives in engine.ts, which installs the table instead", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/workflow/engine.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/runCompleteness|runCheckpoint/u);
    expect(source).toContain("FLOW_STRATEGIES");
  });

  it("a strategy that throws is isolated as an engine fault, as before the seam", async () => {
    const engine = engineFor({});
    engine.setFlowStrategyForTest("agent", () => Promise.reject(new Error("boom")));
    const result = await engine.run(spec([{ id: "a", type: "agent", prompt: "x" }]));
    expect(result.outputs.a).toBeNull();
    expect(result.engineFaults).toBe(1);
    expect(result.faults).toEqual(["a: engine fault: Error: boom"]);
  });
});

describe("cell hashes are unchanged by the migration (#977)", () => {
  const OUTPUT = { complete: true, missing: [] };
  const completeness = (extra: Record<string, unknown> = {}) =>
    spec([
      { id: "c", type: "completeness_check", task: "ship it", results: "found two", ...extra },
    ]);
  const checkpoint = spec([{ id: "cp", type: "checkpoint", prompt: "go on?" }]);

  describe("completeness_check", () => {
    const parts = ["c", "completeness_check", "ship it", "found two"];

    it("a cell written under the pre-seam formula is a hit: no leaf spawns", async () => {
      const cache = new MemoryWorkflowCache();
      cache.put("run", contentHash(NAME, null, ...parts), "c", OUTPUT, null);
      const runtime = new ScriptedRuntime();
      const result = await engineFor({ runtime, cache }).run(completeness());
      expect(runtime.spawned).toHaveLength(0);
      expect(result.outputs.c).toEqual(OUTPUT);
    });

    it("a miss reads and writes exactly that hash, owned by the node", async () => {
      const cache = new RecordingCache();
      const runtime = new ScriptedRuntime([OUTPUT]);
      const result = await engineFor({ runtime, cache }).run(completeness());
      const hash = contentHash(NAME, null, ...parts);
      expect(runtime.spawned).toHaveLength(1);
      expect(runtime.spawned[0]?.causalContext).toMatchObject({
        role: "completeness",
        cellId: hash,
        nodePath: ["c"],
      });
      expect(cache.gets).toEqual([{ hash, nodeId: "c" }]);
      expect(cache.puts).toEqual([{ hash, nodeId: "c", output: OUTPUT }]);
      expect(result.outputs.c).toEqual(OUTPUT);
    });

    it("routing knobs still fold into the cell, after the task and the results", async () => {
      const cache = new MemoryWorkflowCache();
      cache.put("run", contentHash(NAME, null, ...parts, "m-1", null, null), "c", OUTPUT, null);
      const runtime = new ScriptedRuntime();
      const result = await engineFor({ runtime, cache }).run(completeness({ model: "m-1" }));
      expect(runtime.spawned).toHaveLength(0);
      expect(result.outputs.c).toEqual(OUTPUT);
    });

    it("a nested engine puts its node scope right after the spec identity", async () => {
      const cache = new RecordingCache();
      const runtime = new ScriptedRuntime([OUTPUT]);
      await engineFor({ runtime, cache, nodeScope: ["sub"] }).run(completeness());
      expect(cache.puts).toEqual([
        { hash: contentHash(NAME, null, "sub", ...parts), nodeId: "sub.c", output: OUTPUT },
      ]);
    });

    it("a resolved ${ref} hashes its value, and an upstream null spawns nothing", async () => {
      const cache = new MemoryWorkflowCache();
      const hash = contentHash(NAME, null, "c", "completeness_check", "ship it", "from args");
      cache.put("run", hash, "c", OUTPUT, null);
      const runtime = new ScriptedRuntime();
      const nodes = [
        { id: "c", type: "completeness_check", task: "ship it", results: "${args.found}" },
      ];
      const hit = await engineFor({ runtime, cache }).run(spec(nodes), { found: "from args" });
      const nul = await engineFor({ runtime }).run(spec(nodes), { found: null });
      expect(hit.outputs.c).toEqual(OUTPUT);
      expect(nul.outputs.c).toBeNull();
      expect(runtime.spawned).toHaveLength(0);
    });
  });

  describe("checkpoint", () => {
    const parts = ["cp", "checkpoint", "go on?"];

    it("a cell written under the pre-seam formula is a hit: no pause, no answer needed", async () => {
      const cache = new MemoryWorkflowCache();
      cache.put("run", contentHash(NAME, null, ...parts), "cp", "earlier answer", null);
      const control = idleRunControl();
      const result = await engineFor({ cache, control }).run(checkpoint);
      expect(control.paused).toBe(false);
      expect(result.outputs.cp).toBe("earlier answer");
    });

    it("an answer is cached under that hash, owned by the checkpoint id — even an empty one", async () => {
      const hash = contentHash(NAME, null, ...parts);
      for (const answer of ["yes", ""]) {
        const cache = new RecordingCache();
        const result = await engineFor({ cache, checkpointAnswers: { cp: answer } }).run(
          checkpoint,
        );
        expect(result.outputs.cp).toBe(answer);
        expect(cache.puts).toEqual([{ hash, nodeId: "cp", output: answer }]);
      }
    });

    it("a nested engine scopes both the hash and the owner", async () => {
      const cache = new RecordingCache();
      const checkpointAnswers = { "sub.cp": "scoped yes" };
      await engineFor({ cache, nodeScope: ["sub"], checkpointAnswers }).run(checkpoint);
      expect(cache.puts).toEqual([
        { hash: contentHash(NAME, null, "sub", ...parts), nodeId: "sub.cp", output: "scoped yes" },
      ]);
    });

    it("an unanswered checkpoint pauses with the scoped node id and the prompt", async () => {
      const control = idleRunControl();
      const result = await engineFor({ control, nodeScope: ["sub"] }).run(checkpoint);
      expect(result.status).toBe("paused");
      expect(control.pauseReason).toBe("checkpoint");
      expect(control.pausePayload).toEqual({ node_id: "sub.cp", prompt: "go on?" });
      expect(result.faults).toEqual(["cp: checkpoint waiting for answer"]);
      expect(result.outputs.cp).toBeNull();
    });
  });
});

describe("FlowDeps (#977)", () => {
  it("is exactly the surface the flow nodes need, bound and frozen", async () => {
    let captured: FlowDeps | null = null;
    const runtime = new ScriptedRuntime();
    const budget = new Budget();
    await runWith(
      (deps) => {
        captured = deps;
        return Promise.resolve("done");
      },
      { runtime, budget, nodeScope: ["sub"], checkpointAnswers: { a: 1 } },
    );
    const deps = captured as unknown as FlowDeps;
    expect(Object.keys(deps).sort()).toEqual(
      "budget,cache,cacheGet,cachePut,causal,cell,checkpointAnswers,collectLeaf,control,nodeScope,noteItems,pause,recordFault,result,runId,runtime,schemaOf,tiers"
        .split(",")
        .sort(),
    );
    expect(Object.isFrozen(deps)).toBe(true);
    expect(deps.runtime).toBe(runtime);
    expect(deps.budget).toBe(budget);
    expect(deps.runId).toBe("run");
    expect(deps.nodeScope).toEqual(["sub"]);
    expect(deps.checkpointAnswers).toEqual({ a: 1 });
  });

  it("cell is the spec identity (name, version, scope) followed by the parts", async () => {
    const cells: string[] = [];
    await runWith(
      (deps) => {
        cells.push(deps.cell(["n", "probe", 1]), deps.cell([]));
        return Promise.resolve(null);
      },
      { nodeScope: ["sub"] },
    );
    expect(cells).toEqual([
      contentHash(NAME, null, "sub", "n", "probe", 1),
      contentHash(NAME, null, "sub"),
    ]);
  });

  it("cacheGet is CACHE_MISS or the stored output; cachePut skips an empty one", async () => {
    const seen: unknown[] = [];
    const cache = new RecordingCache();
    await runWith(
      (deps) => {
        const hash = deps.cell(["n"]);
        seen.push(deps.cacheGet(hash));
        deps.cachePut(hash, "n", { v: 1 }, usage());
        seen.push(deps.cacheGet(hash));
        deps.cachePut(deps.cell(["empty"]), "n", "", usage());
        seen.push(deps.cacheGet(deps.cell(["empty"])));
        return Promise.resolve(null);
      },
      { cache },
    );
    expect(seen).toEqual([CACHE_MISS, { v: 1 }, CACHE_MISS]);
    expect(cache.puts).toEqual([
      { hash: contentHash(NAME, null, "n"), nodeId: "n", output: { v: 1 } },
    ]);
  });

  it("noteItems, recordFault and pause reach the live events and the run", async () => {
    const events: WorkflowEvent[] = [];
    const control = idleRunControl();
    const result = await runWith(
      (deps) => {
        deps.noteItems("n", 0, 3);
        deps.noteItems("n", 2, 3);
        deps.recordFault("n: something with a cause");
        deps.pause("escalated", "n: needs a person", { node_id: "n", kind: "risk" });
        return Promise.resolve(null);
      },
      { events, control },
    );
    expect(events.filter((event) => event.kind === "items")).toEqual([
      { kind: "items", nodeId: "n", done: 0, total: 3 },
      { kind: "items", nodeId: "n", done: 2, total: 3 },
    ]);
    expect(events).toContainEqual({
      kind: "fault",
      nodeId: "n",
      text: "n: something with a cause",
    });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("escalated");
    expect(result.faults).toEqual(["n: something with a cause", "n: needs a person"]);
    expect(control.pausePayload).toEqual({ node_id: "n", kind: "risk" });
  });

  it("causal builds the context a runtime port needs: run, segment, node path, cell, role", async () => {
    let context: unknown = null;
    await runWith(
      (deps) => {
        context = deps.causal("call", "cell-1", { attempt: 2, itemIndex: 4 });
        return Promise.resolve(null);
      },
      { nodeScope: ["sub"] },
    );
    expect(context).toMatchObject({
      runId: "run",
      nodePath: ["sub", "n"],
      cellId: "cell-1",
      role: "call",
      attempt: 2,
      itemIndex: 4,
      turn: 0,
    });
  });

  it("schemaOf resolves an inline schema, a named one, and a sub-object's own", async () => {
    const got: unknown[] = [];
    const engine = engineFor({});
    engine.setFlowStrategyForTest("agent", (deps, node) => {
      got.push(
        deps.schemaOf(node),
        deps.schemaOf({ schema: { type: "string" } }),
        deps.schemaOf({ prompt: "no schema" }),
      );
      return Promise.resolve(null);
    });
    await engine.run(
      parsed({
        meta: { name: NAME },
        schemas: { VERDICT: { type: "object" } },
        nodes: [{ id: "n", type: "agent", prompt: "x", schema_ref: "VERDICT" }],
      }),
    );
    expect(got).toEqual([{ type: "object" }, { type: "string" }, null]);
  });
});

describe("FlowDeps is enough for the S2/S3/S4/S6 nodes — no engine.ts change (#977)", () => {
  // S2: `switch` picks ONE case by the value of a state field and runs one leaf of its body.
  const switchLike: FlowStrategy = async (deps, node, context) => {
    const chosen = readPath("args.pick", context);
    const hash = deps.cell([node.id, "switch", chosen, ...routingIdentity(node, deps.tiers)]);
    const cached = deps.cacheGet(hash);
    if (cached !== CACHE_MISS) return { case: chosen, matched: true, output: cached };
    // `deps` stands in for the `BodyLeafDeps` the body runner takes: a case's own retries work.
    const runBody = makeBodyLeafRunner(deps, node, { prompt: "case", retries: 1 });
    const options = { role: "switch.case", cellId: hash, itemIndex: 1 };
    const leaf = await runBody(`case ${String(chosen)}`, deps.schemaOf(node), options);
    if (leaf.output !== null) deps.cachePut(hash, node.id, leaf.output, leaf.usage);
    return { case: chosen, matched: leaf.output !== null, output: leaf.output };
  };

  it("S2 switch: one leaf for the chosen case, replayed from its cell on a resume", async () => {
    const cache = new MemoryWorkflowCache();
    const first = new ScriptedRuntime(["investigate"]);
    const result = await runWith(switchLike, { runtime: first, cache, args: { pick: "b" } });
    expect(result.outputs.n).toEqual({ case: "b", matched: true, output: "investigate" });
    expect(first.spawned).toHaveLength(1);
    expect(first.spawned[0]?.causalContext).toMatchObject({ role: "switch.case", itemIndex: 1 });

    const second = new ScriptedRuntime();
    const replay = await runWith(switchLike, { runtime: second, cache, args: { pick: "b" } });
    expect(second.spawned).toHaveLength(0);
    expect(replay.outputs.n).toEqual({ case: "b", matched: true, output: "investigate" });

    const changed = new ScriptedRuntime(["other"]);
    const rerun = await runWith(switchLike, { runtime: changed, cache, args: { pick: "c" } });
    expect(changed.spawned).toHaveLength(1);
    expect(rerun.outputs.n).toEqual({ case: "c", matched: true, output: "other" });
  });

  it("S2 switch: the body runner respawns a dead leaf through the same deps", async () => {
    const runtime = new ScriptedRuntime([DEAD, "second try"]);
    const result = await runWith(switchLike, { runtime, args: { pick: "b" } });
    expect(runtime.spawned).toHaveLength(2);
    expect(result.outputs.n).toEqual({ case: "b", matched: true, output: "second try" });
    expect(result.leafRespawns).toBe(1);
  });

  // S3: `loop` runs one cell per round until a predicate holds, capped by max_rounds.
  const MAX_ROUNDS = 3;
  const loopLike: FlowStrategy = async (deps, node, context) => {
    deps.budget.checkFanout(MAX_ROUNDS);
    deps.noteItems(node.id, 0, MAX_ROUNDS);
    let last: unknown = null;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const hash = deps.cell([node.id, "loop", round]);
      const cached = deps.cacheGet(hash);
      if (cached !== CACHE_MISS) {
        last = cached;
      } else {
        const options = { role: "loop.round", cellId: hash, attempt: round };
        const leaf = await deps.collectLeaf(node, `round ${String(round)}`, null, options);
        if (leaf.output === null) return null;
        deps.cachePut(hash, node.id, leaf.output, leaf.usage);
        last = leaf.output;
      }
      deps.noteItems(node.id, round + 1, MAX_ROUNDS);
      const until = { field_equals: { path: "${last}", value: "stop" } } as const;
      if (evaluatePredicate(until, { ...context, last }))
        return { last, rounds: round + 1, until_met: true };
    }
    deps.recordFault(`${node.id}: reached max_rounds ${String(MAX_ROUNDS)} without until`);
    return { last, rounds: MAX_ROUNDS, until_met: false };
  };

  it("S3 loop: stops on the predicate, with one items event per round", async () => {
    const events: WorkflowEvent[] = [];
    const runtime = new ScriptedRuntime(["go", "stop", "never"]);
    const result = await runWith(loopLike, { runtime, events });
    expect(result.outputs.n).toEqual({ last: "stop", rounds: 2, until_met: true });
    expect(runtime.spawned).toHaveLength(2);
    const items = events.filter((event) => event.kind === "items");
    expect(items.map((event) => `${String(event.done)}/${String(event.total)}`)).toEqual([
      "0/3",
      "1/3",
      "2/3",
    ]);
    expect(result.faults).toEqual([]);
  });

  it("S3 loop: the cap ends it with a named fault", async () => {
    const result = await runWith(loopLike, { runtime: new ScriptedRuntime(["go", "go", "go"]) });
    expect(result.outputs.n).toEqual({ last: "go", rounds: 3, until_met: false });
    expect(result.faults).toEqual(["n: reached max_rounds 3 without until"]);
  });

  it("S3 loop: checkFanout up front rejects before round 0, counted as a cap trip", async () => {
    const runtime = new ScriptedRuntime(["go"]);
    const result = await runWith(loopLike, { runtime, budget: new Budget({ maxFanout: 2 }) });
    expect(runtime.spawned).toHaveLength(0);
    expect(result.capTrips).toBe(1);
    expect(result.outputs.n).toBeNull();
    expect(result.faults[0]).toContain("max_fanout");
  });

  it("S3 loop: a resume replays the finished rounds without a spawn", async () => {
    const cache = new MemoryWorkflowCache();
    const first = new ScriptedRuntime(["go"]); // round 1 dies: the script runs dry
    await runWith(loopLike, { runtime: first, cache });
    expect(first.spawned).toHaveLength(2);

    const second = new ScriptedRuntime(["stop"]);
    const result = await runWith(loopLike, { runtime: second, cache });
    expect(second.spawned).toHaveLength(1);
    expect(second.spawned[0]?.causalContext.attempt).toBe(1);
    expect(result.outputs.n).toEqual({ last: "stop", rounds: 2, until_met: true });
  });

  // S4: `escalate` pauses the run, only when its predicate holds, and resumes on an answer.
  const escalateLike: FlowStrategy = (deps, node, context) => {
    if (!evaluatePredicate({ field_true: { path: "${args.risky}" } }, context))
      return Promise.resolve({ escalated: false });
    const hash = deps.cell([node.id, "escalate", "needs review"]);
    const cached = deps.cacheGet(hash);
    if (cached !== CACHE_MISS) return Promise.resolve(cached);
    const resolved = resolveCheckpoint(deps.checkpointAnswers, deps.nodeScope, node.id);
    if (resolved.matched) {
      const out = { escalated: true, answer: resolved.answer };
      deps.cache.put(deps.runId, hash, resolved.scoped, out, null);
      return Promise.resolve(out);
    }
    deps.pause("escalated", `${node.id}: escalated for review`, {
      node_id: resolved.scoped,
      kind: "risk",
      summary: "needs review",
    });
    return Promise.resolve(null);
  };

  it("S4 escalate: a false predicate costs nothing and does not pause", async () => {
    const control = idleRunControl();
    const result = await runWith(escalateLike, { control, args: { risky: false } });
    expect(result.outputs.n).toEqual({ escalated: false });
    expect(control.paused).toBe(false);
  });

  it("S4 escalate: a true predicate pauses with the scoped id in the payload", async () => {
    const control = idleRunControl();
    const result = await runWith(escalateLike, {
      control,
      nodeScope: ["sub"],
      args: { risky: true },
    });
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("escalated");
    expect(control.pausePayload).toEqual({
      node_id: "sub.n",
      kind: "risk",
      summary: "needs review",
    });
  });

  it("S4 escalate: the answer arrives through checkpointAnswers and is cached, so it never asks twice", async () => {
    const cache = new MemoryWorkflowCache();
    const args = { risky: true };
    const answered = await runWith(escalateLike, { cache, args, checkpointAnswers: { n: "ok" } });
    expect(answered.status).toBe("complete");
    expect(answered.outputs.n).toEqual({ escalated: true, answer: "ok" });

    const control = idleRunControl();
    const again = await runWith(escalateLike, { cache, control, args });
    expect(control.paused).toBe(false);
    expect(again.outputs.n).toEqual({ escalated: true, answer: "ok" });
  });

  // S6: `call` runs a tool with no model; each attempt is one fan-out slot and one charge.
  const callLike: FlowStrategy = (deps, node) => {
    if (deps.control.cancelled || deps.control.paused) return Promise.resolve(null);
    const hash = deps.cell([node.id, "call", "read_file"]);
    deps.budget.checkFanout(1);
    deps.budget.charge();
    return Promise.resolve({
      attemptContext: deps.causal("call", hash, { attempt: 0 }),
      runtime: deps.runtime,
      remaining: deps.budget.lifetimeRemaining,
    });
  };

  it("S6 call: the runtime, the budget and the causal context are all reachable", async () => {
    const runtime = new ScriptedRuntime();
    const budget = new Budget({ lifetime: 5 });
    const result = await runWith(callLike, { runtime, budget });
    const out = result.outputs.n as {
      attemptContext: unknown;
      runtime: unknown;
      remaining: number;
    };
    expect(out.runtime).toBe(runtime);
    expect(out.remaining).toBe(4);
    expect(out.attemptContext).toMatchObject({ role: "call", nodePath: ["n"], attempt: 0 });
  });

  it("S6 call: an exhausted lifetime is a cap trip, and a stopped run makes no attempt", async () => {
    const spent = new Budget({ lifetime: 1 });
    spent.charge();
    const trip = await runWith(callLike, { budget: spent });
    expect(trip.capTrips).toBe(1);
    expect(trip.outputs.n).toBeNull();
    expect(trip.faults[0]).toContain("lifetime remaining 0");

    const control = idleRunControl();
    control.paused = true;
    const fresh = new Budget({ lifetime: 5 });
    await runWith(callLike, { budget: fresh, control });
    expect(fresh.lifetimeRemaining).toBe(5);
  });
});

describe("validateGate lives in schema-nodes.ts (#977)", () => {
  const run = (node: Node): SpecIssue[] => {
    const issues: SpecIssue[] = [];
    validateGate(node, issues);
    return issues;
  };

  it("is dispatched by node type through NODE_VALIDATORS", () => {
    expect(NODE_VALIDATORS.get("gate")).toBe(validateGate);
    for (const type of NODE_VALIDATORS.keys()) expect(NODE_TYPES.has(type)).toBe(true);
  });

  it("accepts a well formed gate and ignores every other type", () => {
    const gate = new Node("g", "gate", { body: { prompt: "draft" }, validator: "is it good?" });
    expect(run(gate)).toEqual([]);
    expect(run(new Node("a", "agent", { prompt: "x" }))).toEqual([]);
  });

  it("refuses a body without a prompt, a blank validator and a bad attempts count", () => {
    const issues = run(new Node("g", "gate", { body: {}, validator: " ", attempts: 9 }));
    expect(issues.map((issue) => issue.field)).toEqual(["body", "validator", "attempts"]);
    expect(issues.every((issue) => issue.rule === "field_value" && issue.nodeId === "g")).toBe(
      true,
    );
    expect(issues.every((issue) => issue.example !== null)).toBe(true);
  });

  it("validateSpec still reports it, and schema.ts no longer defines it", () => {
    const refused = validateSpec({
      meta: { name: "g" },
      nodes: [{ id: "g", type: "gate", body: {}, validator: "ok" }],
    });
    expect("issues" in refused && refused.issues.map((issue) => issue.field)).toEqual(["body"]);
    const source = readFileSync(
      fileURLToPath(new URL("../src/workflow/schema.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/function validateGate/u);
  });
});
