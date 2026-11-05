// Issue #979 (S2 do épico #976): o nó `switch` escolhe UM caso pelo valor de
// um campo do estado e roda exatamente o leaf desse caso. O que prende:
//   - o valor escalar (string, número, booleano) escolhe a chave; `otherwise`
//     cobre o que não casa, com `matched:false`; sem `otherwise`, fault com o
//     valor e saída null; um valor não escalar nunca casa;
//   - a guarda de upstream: a RAIZ do `value` null dá `<id>: upstream null`,
//     mas um campo ausente de uma raiz presente NÃO é upstream null;
//   - um leaf só, com role `switch.case` e `item_index`; os outros casos não
//     geram spawn, célula, chave nem resolução do prompt;
//   - a identidade da célula (hash pinado) e o resume: mesmo caso reaproveita,
//     outro caso roda com `identity_changed`;
//   - os knobs do corpo do caso e o roteamento do nó chegam ao leaf.
// O ledger e o preview ficam em `tests/workflow-cache-preview-flow.test.ts`.
import { describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { Budget } from "../src/workflow/budget.js";
import { contentHash, MemoryWorkflowCache, type CacheLookup } from "../src/workflow/cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { validateSpec } from "../src/workflow/schema.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import type { WorkflowSpec } from "../src/workflow/types.js";

const NAME = "switch-run";
const DEAD = Symbol("dead leaf");

/** Hands out the scripted outputs in order; a `failed` for `DEAD` or once the script runs dry. */
class ScriptedRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  readonly collected: ChildCollectOptions[] = [];
  private readonly pending: unknown[];

  constructor(outputs: readonly unknown[] = []) {
    this.pending = [...outputs];
  }

  spawn(request: ChildSpawnRequest): string {
    this.spawned.push(request);
    return `leaf-${String(this.spawned.length)}`;
  }

  collect(_id: string, options: ChildCollectOptions): ChildResult {
    this.collected.push(options);
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

interface Lookup {
  readonly hash: string;
  readonly nodeId: string | undefined;
  readonly hit: boolean;
  readonly miss: CacheLookup["miss"];
}

/** A cache that remembers every lookup and every write, and under which owner. */
class RecordingCache extends MemoryWorkflowCache {
  readonly gets: Lookup[] = [];
  readonly puts: { readonly hash: string; readonly nodeId: string; readonly output: unknown }[] =
    [];

  override get(runId: string, hash: string, nodeId?: string): CacheLookup {
    const found = super.get(runId, hash, nodeId);
    this.gets.push({ hash, nodeId, hit: found.hit, miss: found.miss });
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
  readonly nodeScope?: readonly string[];
}

function run(
  runtime: ScriptedRuntime,
  workflow: WorkflowSpec,
  args: Record<string, unknown> = {},
  options: Options = {},
) {
  return new WorkflowEngine({
    runtime,
    runId: "run",
    logError: () => undefined,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.nodeScope === undefined ? {} : { nodeScope: options.nodeScope }),
  }).run(workflow, args);
}

const CLASSIFY = { id: "classify", type: "agent", prompt: "Classify ${args.text}" };

const route = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "route",
  type: "switch",
  value: "${classify.kind}",
  cases: {
    reuse: null,
    investigate: { prompt: "Investigate ${args.text}" },
    escalate: { prompt: "Escalate ${args.text}" },
  },
  ...extra,
});

/** A switch that reads `args.pick`, for the runs that need to move the value by hand. */
const byArg = (extra: Record<string, unknown> = {}): WorkflowSpec =>
  spec([route({ value: "${args.pick}", ...extra })]);

const ARGS = { text: "hello" };

describe("a scalar value picks the case and runs exactly its leaf (#979)", () => {
  it("returns {case, matched, output} and spawns one leaf with the case's prompt", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "dug in"]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: true, output: "dug in" });
    expect(runtime.spawned).toHaveLength(2);
    expect(runtime.spawned[1]?.prompt).toBe("Investigate hello");
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
    expect(Object.isFrozen(result.outputs.route)).toBe(true);
  });

  it("the leaf carries role switch.case and the case's position as item_index, under the node's path", async () => {
    for (const [kind, index] of [
      ["investigate", 1],
      ["escalate", 2],
    ] as const) {
      const runtime = new ScriptedRuntime([{ kind }, "done"]);
      await run(runtime, spec([CLASSIFY, route()]), ARGS);
      expect(runtime.spawned[1]?.causalContext).toMatchObject({
        role: "switch.case",
        nodePath: ["route"],
        itemIndex: index,
        attempt: 0,
      });
    }
  });

  it.each([
    ["a number", 1, "1"],
    ["a decimal", 2.5, "2.5"],
    ["true", true, "true"],
    ["false", false, "false"],
  ])("matches %s by its string form", async (_label, picked, key) => {
    const workflow = byArg({
      cases: {
        "1": { prompt: "one" },
        "2.5": { prompt: "decimal" },
        true: null,
        false: { prompt: "no" },
      },
    });
    const runtime = new ScriptedRuntime(["ran"]);
    const result = await run(runtime, workflow, { pick: picked });
    const out = result.outputs.route as { case: string; matched: boolean };
    expect(out.case).toBe(key);
    expect(out.matched).toBe(true);
  });

  it("downstream nodes read the pieces with ${route.case} and ${route.output}", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "dug in", "report"]);
    const result = await run(
      runtime,
      spec([
        CLASSIFY,
        route(),
        { id: "report", type: "agent", prompt: "Write up ${route.case}: ${route.output}" },
      ]),
      ARGS,
    );
    expect(runtime.spawned[2]?.prompt).toBe("Write up investigate: dug in");
    expect(result.outputs.report).toBe("report");
  });
});

describe("only the chosen case exists at run time (#979)", () => {
  it("spawns, looks up and stores for the chosen case alone", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "dug in"]);
    await run(runtime, spec([CLASSIFY, route()]), ARGS, { cache });
    const mine = cache.of("route");
    expect(mine.gets).toHaveLength(1);
    expect(mine.puts).toEqual([
      {
        hash: contentHash(NAME, null, "route", "switch", "investigate", "Investigate hello", null),
        nodeId: "route",
        output: "dug in",
      },
    ]);
    expect(runtime.spawned.filter((s) => s.causalContext.role === "switch.case")).toHaveLength(1);
  });

  it("never resolves the prompt of a case that was not chosen", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "dug in"]);
    const result = await run(
      runtime,
      spec([
        CLASSIFY,
        route({
          cases: {
            investigate: { prompt: "Investigate ${args.text}" },
            escalate: { prompt: "Escalate ${args.never_given}" },
          },
        }),
      ]),
      ARGS,
    );
    expect(result.faults).toEqual([]);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: true, output: "dug in" });
  });

  it("a null case runs nothing: no spawn, no cell, no lookup, and the node is not null", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([{ kind: "reuse" }]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS, { cache });
    expect(result.outputs.route).toEqual({ case: "reuse", matched: true, output: null });
    expect(runtime.spawned).toHaveLength(1);
    expect(cache.of("route")).toEqual({ gets: [], puts: [] });
    expect(result.nullCount).toBe(0);
    expect(result.status).toBe("complete");
    expect(result.faults).toEqual([]);
  });

  it("a null case consumes no budget: a one-leaf lifetime still finishes", async () => {
    const runtime = new ScriptedRuntime([{ kind: "reuse" }]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS, {
      budget: new Budget({ lifetime: 1 }),
    });
    expect(result.capTrips).toBe(0);
    expect(result.outputs.route).toEqual({ case: "reuse", matched: true, output: null });
  });

  it("a chosen case is one leaf for the gate: an exhausted lifetime is a cap trip, counted and named", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "never"]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS, {
      budget: new Budget({ lifetime: 1 }),
    });
    expect(runtime.spawned).toHaveLength(1);
    expect(result.capTrips).toBe(1);
    expect(result.outputs.route).toBeNull();
    expect(result.faults.join("\n")).toMatch(/^route: .*lifetime/mu);
  });
});

describe("no case matches (#979)", () => {
  it("falls to otherwise with matched:false, running that case's leaf", async () => {
    const runtime = new ScriptedRuntime([{ kind: "weird" }, "dug in"]);
    const result = await run(runtime, spec([CLASSIFY, route({ otherwise: "investigate" })]), ARGS);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: false, output: "dug in" });
    expect(runtime.spawned[1]?.causalContext).toMatchObject({ role: "switch.case", itemIndex: 1 });
    expect(result.faults).toEqual([]);
  });

  it("otherwise may name the null case: nothing runs, matched is still false", async () => {
    const runtime = new ScriptedRuntime([{ kind: "weird" }]);
    const result = await run(runtime, spec([CLASSIFY, route({ otherwise: "reuse" })]), ARGS);
    expect(result.outputs.route).toEqual({ case: "reuse", matched: false, output: null });
    expect(runtime.spawned).toHaveLength(1);
  });

  it("without otherwise it is a fault that names the value, and the output is null", async () => {
    const runtime = new ScriptedRuntime([{ kind: "weird" }]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS);
    expect(result.outputs.route).toBeNull();
    expect(result.faults).toEqual([
      'route: no case matches "weird" and the switch has no otherwise',
    ]);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.nullCount).toBe(1);
    expect(result.status).not.toBe("complete");
  });

  it("an absent field is null, which matches nothing: the fault says null, not upstream null", async () => {
    const runtime = new ScriptedRuntime([{ other: 1 }]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS);
    expect(result.faults).toEqual(["route: no case matches null and the switch has no otherwise"]);
  });

  it.each([
    ["an object", { deep: 1 }, '{"deep":1}'],
    ["a list holding the case name", ["investigate"], '["investigate"]'],
    ["a list of one number", [1], "[1]"],
  ])("%s is never coerced into a case name", async (_label, kind, shown) => {
    const workflow = spec([
      CLASSIFY,
      route({ cases: { investigate: { prompt: "x" }, "1": null } }),
    ]);
    const runtime = new ScriptedRuntime([{ kind }]);
    const result = await run(runtime, workflow, ARGS);
    expect(result.outputs.route).toBeNull();
    expect(result.faults).toEqual([
      `route: no case matches ${shown} and the switch has no otherwise`,
    ]);
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "an inherited name (%s) is not a case: it falls to otherwise",
    async (kind) => {
      const runtime = new ScriptedRuntime([{ kind }]);
      const result = await run(runtime, spec([CLASSIFY, route({ otherwise: "reuse" })]), ARGS);
      expect(result.outputs.route).toEqual({ case: "reuse", matched: false, output: null });
    },
  );

  it("a huge value keeps the fault short", async () => {
    const runtime = new ScriptedRuntime([{ kind: "x".repeat(5000) }]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS);
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]?.length).toBeLessThan(200);
    expect(result.faults[0]).toContain("xxxx");
  });

  it("reads through a JSON string and an array index like ${ref} does", async () => {
    const runtime = new ScriptedRuntime([JSON.stringify({ kind: "investigate" }), "dug in"]);
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: true, output: "dug in" });

    const indexed = spec([
      CLASSIFY,
      route({ value: "${classify.labels.1}", cases: { b: { prompt: "p" }, a: null } }),
    ]);
    const second = await run(new ScriptedRuntime([{ labels: ["a", "b"] }, "ok"]), indexed, ARGS);
    expect(second.outputs.route).toEqual({ case: "b", matched: true, output: "ok" });
  });
});

describe("upstream null guard (#979)", () => {
  it("a null root fails the node with '<id>: upstream null' and spawns nothing", async () => {
    const runtime = new ScriptedRuntime([DEAD]);
    const result = await run(runtime, spec([CLASSIFY, route({ otherwise: "reuse" })]), ARGS);
    expect(result.outputs.classify).toBeNull();
    expect(result.outputs.route).toBeNull();
    expect(result.faults.filter((fault) => fault.startsWith("route:"))).toEqual([
      "route: upstream null",
    ]);
    expect(runtime.spawned).toHaveLength(1);
  });

  it("holds even when otherwise would have caught a missing field: a dead upstream is not 'no match'", async () => {
    const dead = await run(
      new ScriptedRuntime([DEAD]),
      spec([CLASSIFY, route({ otherwise: "reuse" })]),
      ARGS,
    );
    const absent = await run(
      new ScriptedRuntime([{ other: 1 }]),
      spec([CLASSIFY, route({ otherwise: "reuse" })]),
      ARGS,
    );
    expect(dead.outputs.route).toBeNull();
    expect(absent.outputs.route).toEqual({ case: "reuse", matched: false, output: null });
  });

  it("only the ROOT counts: a present root with a null field is a value, not an upstream failure", async () => {
    const runtime = new ScriptedRuntime([{ kind: null }]);
    const result = await run(runtime, spec([CLASSIFY, route({ otherwise: "reuse" })]), ARGS);
    expect(result.faults).toEqual([]);
    expect(result.outputs.route).toEqual({ case: "reuse", matched: false, output: null });
  });

  it("reading args is never an upstream failure, even for a field that was not given", async () => {
    const result = await run(new ScriptedRuntime(), byArg({ otherwise: "reuse" }), {});
    expect(result.faults).toEqual([]);
    expect(result.outputs.route).toEqual({ case: "reuse", matched: false, output: null });
  });

  it("a chosen case whose prompt reads a null is upstream null too, and nothing spawns", async () => {
    const runtime = new ScriptedRuntime(["never"]);
    const result = await run(runtime, byArg(), { pick: "investigate" });
    expect(result.outputs.route).toBeNull();
    expect(result.faults).toEqual(["route: upstream null"]);
    expect(runtime.spawned).toHaveLength(0);
  });
});

describe("the chosen leaf's own outcome (#979)", () => {
  it("a dead leaf nulls the node and keeps the cause the leaf recorded", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, DEAD]);
    const cache = new RecordingCache();
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS, { cache });
    expect(result.outputs.route).toBeNull();
    expect(result.faults).toHaveLength(1);
    expect(result.faults[0]).toMatch(/^route: leaf failed/u);
    expect(cache.of("route").puts).toEqual([]);
  });

  it("an empty answer is a fault, not a silent success, and it is never cached", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, ""]);
    const cache = new RecordingCache();
    const result = await run(runtime, spec([CLASSIFY, route()]), ARGS, { cache });
    expect(result.outputs.route).toBeNull();
    expect(result.faults).toEqual(["route: case investigate returned an empty output"]);
    expect(cache.of("route").puts).toEqual([]);
  });

  it("a case's retries respawn a dead leaf under the same role and item_index", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, DEAD, "second try"]);
    const result = await run(
      runtime,
      spec([
        CLASSIFY,
        route({
          cases: { reuse: null, investigate: { prompt: "Investigate ${args.text}", retries: 1 } },
        }),
      ]),
      ARGS,
    );
    expect(result.outputs.route).toEqual({
      case: "investigate",
      matched: true,
      output: "second try",
    });
    expect(runtime.spawned).toHaveLength(3);
    expect(result.leafRespawns).toBe(1);
    for (const request of runtime.spawned.slice(1)) {
      expect(request.causalContext).toMatchObject({ role: "switch.case", itemIndex: 1 });
    }
  });
});

describe("the case body's knobs and the node's routing reach the leaf (#979)", () => {
  const investigate = (body: Record<string, unknown>): WorkflowSpec =>
    spec([CLASSIFY, route({ cases: { reuse: null, investigate: { prompt: "go", ...body } } })]);

  it("max_iterations and timeout of the chosen case are the leaf's", async () => {
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "ok"]);
    await run(runtime, investigate({ max_iterations: 7, timeout: 33 }), ARGS);
    expect(runtime.spawned[1]?.maxIterations).toBe(7);
    expect(runtime.collected[1]?.timeoutSeconds).toBe(33);
    expect(runtime.spawned[0]?.maxIterations).not.toBe(7);
  });

  it("a case schema_ref forces a tool_less leaf into the named schema", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const workflow = spec(
      [
        CLASSIFY,
        route({
          cases: {
            reuse: null,
            investigate: { prompt: "go", tool_less: true, schema_ref: "VERDICT" },
          },
        }),
      ],
      { schemas: { VERDICT: schema } },
    );
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, { ok: true }]);
    const result = await run(runtime, workflow, ARGS);
    expect(runtime.spawned[1]?.forcedTool).toMatchObject({ name: "StructuredOutput", schema });
    expect(result.outputs.route).toEqual({
      case: "investigate",
      matched: true,
      output: { ok: true },
    });
  });

  it("node-level routing is the leaf's routing, and part of the cell", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime([{ kind: "investigate" }, "ok"]);
    await run(runtime, spec([CLASSIFY, route({ provider: "p" })]), ARGS, { cache });
    expect(runtime.spawned[1]?.provider).toBe("p");
    expect(runtime.spawned[0]?.provider).toBeUndefined();
    expect(cache.of("route").puts[0]?.hash).toBe(
      contentHash(
        NAME,
        null,
        "route",
        "switch",
        "investigate",
        "Investigate hello",
        null,
        null,
        null,
        "p",
      ),
    );
  });

  it("a knob in the case body is part of the cell: the same prompt with another knob is another cell", async () => {
    const cache = new RecordingCache();
    await run(
      new ScriptedRuntime([{ kind: "investigate" }, "a"]),
      investigate({ max_iterations: 7 }),
      ARGS,
      { cache },
    );
    const second = new ScriptedRuntime(["b"]);
    const result = await run(second, investigate({ max_iterations: 8 }), ARGS, { cache });
    expect(second.spawned).toHaveLength(1);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: true, output: "b" });
    const stored = cache.of("route").puts;
    expect(stored).toHaveLength(2);
    expect(stored[0]?.hash).not.toBe(stored[1]?.hash);
  });

  it("a nested switch keys its cell under the scope: <scope>.<id>", async () => {
    const cache = new RecordingCache();
    const runtime = new ScriptedRuntime(["ok"]);
    await run(
      runtime,
      byArg(),
      { pick: "investigate", text: "hello" },
      { cache, nodeScope: ["sub"] },
    );
    expect(cache.puts).toEqual([
      {
        hash: contentHash(
          NAME,
          null,
          "sub",
          "route",
          "switch",
          "investigate",
          "Investigate hello",
          null,
        ),
        nodeId: "sub.route",
        output: "ok",
      },
    ]);
  });
});

describe("a resume re-reads the value (#979)", () => {
  const workflow = byArg({ otherwise: "investigate" });
  const first = (pick: string) => ({ pick, text: "hello" });

  it("the same value replays the cell without a spawn", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime(["dug in"]), workflow, first("investigate"), { cache });
    const second = new ScriptedRuntime();
    const result = await run(second, workflow, first("investigate"), { cache });
    expect(second.spawned).toHaveLength(0);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: true, output: "dug in" });
    expect(cache.of("route").gets.map((entry) => entry.hit)).toEqual([false, true]);
    expect(cache.of("route").gets[0]?.miss).toBe("never_completed");
  });

  it("a changed value runs the new case, and the miss says the identity changed", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime(["dug in"]), workflow, first("investigate"), { cache });
    const second = new ScriptedRuntime(["escalated"]);
    const result = await run(second, workflow, first("escalate"), { cache });
    expect(second.spawned).toHaveLength(1);
    expect(second.spawned[0]?.prompt).toBe("Escalate hello");
    expect(second.spawned[0]?.causalContext.itemIndex).toBe(2);
    expect(result.outputs.route).toEqual({ case: "escalate", matched: true, output: "escalated" });
    const lookups = cache.of("route").gets;
    expect(lookups.at(-1)).toMatchObject({ hit: false, miss: "identity_changed" });

    const third = new ScriptedRuntime();
    const back = await run(third, workflow, first("investigate"), { cache });
    expect(third.spawned).toHaveLength(0);
    expect(back.outputs.route).toEqual({ case: "investigate", matched: true, output: "dug in" });
  });

  it("another value that lands on the same case through otherwise reuses the cell and says matched:false", async () => {
    const cache = new RecordingCache();
    await run(new ScriptedRuntime(["dug in"]), workflow, first("foo"), { cache });
    const second = new ScriptedRuntime();
    const result = await run(second, workflow, first("bar"), { cache });
    expect(second.spawned).toHaveLength(0);
    expect(result.outputs.route).toEqual({ case: "investigate", matched: false, output: "dug in" });
  });

  it("a changed prompt for the same case is another cell", async () => {
    const cache = new RecordingCache();
    await run(
      new ScriptedRuntime(["one"]),
      workflow,
      { pick: "investigate", text: "a" },
      { cache },
    );
    const second = new ScriptedRuntime(["two"]);
    await run(second, workflow, { pick: "investigate", text: "b" }, { cache });
    expect(second.spawned).toHaveLength(1);
    expect(cache.of("route").gets.at(-1)?.miss).toBe("identity_changed");
  });
});
