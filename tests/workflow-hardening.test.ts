import { describe, expect, it } from "vitest";

import {
  Budget,
  contentHash,
  MemoryWorkflowCache,
  parseAndValidate,
  WorkflowEngine,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

const meters = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 3,
  cacheWriteTokens: 5,
  reasoningTokens: 7,
});

const complete = (output: unknown, input = 1, generated = 1): ChildResult => ({
  status: "complete",
  output,
  usage: meters(input, generated),
  provider: "stub",
  model: "canned",
});

class ScriptRuntime implements ChildRuntime {
  readonly requests: ChildSpawnRequest[] = [];
  readonly collects: ChildCollectOptions[] = [];
  readonly steers: string[] = [];
  readonly cancelled: string[] = [];
  private readonly pending: ChildResult[][];
  private readonly active = new Map<string, ChildResult[]>();

  constructor(scripts: ChildResult[][]) {
    this.pending = scripts.map((script) => [...script]);
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.requests.length + 1)}`;
    this.requests.push(request);
    this.active.set(id, this.pending.shift() ?? []);
    return id;
  }

  collect(id: string, options: ChildCollectOptions): ChildResult {
    this.collects.push(options);
    return this.active.get(id)?.shift() ?? { status: "failed", output: "missing script" };
  }

  steer(_id: string, prompt: string): void {
    this.steers.push(prompt);
  }

  cancel(id: string): void {
    this.cancelled.push(id);
  }
}

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

function agentSpec(fields: Record<string, unknown> = {}) {
  return {
    meta: { name: "manifest", version: 1 },
    nodes: [
      {
        id: "a",
        type: "agent",
        prompt: "prompt",
        schema: { type: "string" },
        model: "m1",
        effort: "low",
        provider: "p1",
        timeout: 1,
        retries: 0,
        max_iterations: 50,
        ...fields,
      },
    ],
  };
}

describe("workflow authored boundaries", () => {
  it("keeps the measured caps distinct from defaults and deadlines", () => {
    expect(validateSpec(agentSpec({ retries: 3 }))).not.toHaveProperty("issues");
    expect(validateSpec(agentSpec({ retries: 4 }))).toHaveProperty("issues");
    expect(validateSpec(agentSpec({ max_iterations: 128 }))).not.toHaveProperty("issues");
    expect(validateSpec(agentSpec({ max_iterations: 129 }))).toHaveProperty("issues");
    expect(validateSpec(agentSpec({ timeout: 121 }))).not.toHaveProperty("issues");
    for (const invalid of [0, -1, true, "120"]) {
      expect(validateSpec(agentSpec({ timeout: invalid }))).toHaveProperty("issues");
    }
    const gate = (attempts: number) => ({
      meta: { name: "gate-boundary" },
      nodes: [{ id: "g", type: "gate", body: { prompt: "draft" }, validator: "review", attempts }],
    });
    expect(validateSpec(gate(3))).not.toHaveProperty("issues");
    expect(validateSpec(gate(4))).toHaveProperty("issues");
  });

  it("accepts pipeline stage retries=4 but clamps to three extras", async () => {
    const runtime = new ScriptRuntime([
      [complete("")],
      [complete("")],
      [complete("")],
      [complete("")],
      [complete("must-not-spawn")],
    ]);
    const workflow = parsed({
      meta: { name: "pipeline-retries" },
      nodes: [{ id: "p", type: "pipeline", items: ["x"], stages: [{ prompt: "${item}", retries: 4 }] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(workflow);
    expect(runtime.requests).toHaveLength(4);
    expect(result.outputs.p).toEqual([null]);
  });

  it("rejects dynamic fanout before spawning and records one cap trip", async () => {
    const runtime = new ScriptRuntime([]);
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ maxFanout: 2 }),
    }).run(
      parsed({
        meta: { name: "dynamic-fanout" },
        nodes: [{ id: "p", type: "parallel", branches: "${args.branches}" }],
      }),
      { branches: ["a", "b", "c"] },
    );
    expect(runtime.requests).toHaveLength(0);
    expect(result.capTrips).toBe(1);
    expect(result.faults).toHaveLength(1);
  });

  it("rejects pipeline item width before the first spawn", async () => {
    const runtime = new ScriptRuntime([[complete("a")], [complete("b")], [complete("c")]]);
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ maxFanout: 2 }),
    }).run(
      parsed({
        meta: { name: "pipeline-fanout" },
        nodes: [
          { id: "p", type: "pipeline", items: ["a", "b", "c"], stages: [{ prompt: "${item}" }] },
        ],
      }),
    );
    expect(runtime.requests).toHaveLength(0);
    expect(result.outputs.p).toBeNull();
    expect(result.capTrips).toBe(1);
    expect(result.status).toBe("failed");
  });

  it("normalizes NaN structural limits to one", () => {
    const budget = new Budget({ poolWidth: Number.NaN, maxFanout: Number.NaN, lifetime: Number.NaN });
    expect(budget.poolWidth).toBe(1);
    expect(budget.maxFanout).toBe(1);
    expect(budget.lifetimeRemaining).toBe(1);
    expect(() => {
      budget.checkFanout(1_000_000_000);
    }).toThrow();
  });
});

describe("workflow Draft 2020-12 output validation", () => {
  const rejected: readonly [unknown, Readonly<Record<string, unknown>>][] = [
    [1, { type: "number", minimum: 10 }],
    [{ known: true, extra: true }, { type: "object", properties: { known: { type: "boolean" } }, additionalProperties: false }],
    [JSON.stringify("abc"), { type: "string", pattern: "^z+$" }],
    [[1], { type: "array", minItems: 2 }],
    [3, { oneOf: [{ type: "string" }, { type: "number", minimum: 5 }] }],
  ];

  for (const [value, schema] of rejected) {
    it(`rejects ${JSON.stringify(value)} against ${JSON.stringify(schema)}`, () => {
      expect(parseAndValidate(value, schema).ok).toBe(false);
    });
  }
});

describe("workflow validation and lifecycle", () => {
  it("uses at most two steers and charges only the final aggregate usage", async () => {
    const runtime = new ScriptRuntime([
      [
        complete('{"wrong":1}', 2, 3),
        complete('{"wrong":2}', 4, 6),
        complete('{"value":3}', 8, 13),
      ],
    ]);
    const result = await new WorkflowEngine({ runtime }).run(
      parsed({
        meta: { name: "steer" },
        nodes: [{ id: "a", type: "agent", prompt: "x", schema: { type: "object", required: ["value"] } }],
      }),
    );
    expect(runtime.steers).toHaveLength(2);
    expect(result.validationRetries).toBe(2);
    expect(result.tokensIn).toBe(8);
    expect(result.tokensOut).toBe(13);
  });

  it("uses the leaf timeout default, accepts an override and cancels expiry", async () => {
    const runtime = new ScriptRuntime([
      [{ status: "running", output: null }],
      [complete("ok")],
    ]);
    const workflow = parsed({
      meta: { name: "timeouts" },
      nodes: [
        { id: "default", type: "agent", prompt: "a", retries: 0 },
        { id: "override", type: "agent", prompt: "b", timeout: 121 },
      ],
    });
    await new WorkflowEngine({ runtime }).run(workflow);
    expect(runtime.collects.map((entry) => entry.timeoutSeconds)).toEqual([120, 121]);
    expect(runtime.cancelled).toEqual(["leaf-1"]);
  });
});

describe("workflow cache manifests", () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ["prompt", { prompt: "changed" }],
    ["schema", { schema: { type: "string", enum: ["ok"] } }],
    ["model", { model: "m2" }],
    ["effort", { effort: "high" }],
    ["provider", { provider: "p2" }],
    ["timeout", { timeout: 121 }],
    ["retries", { retries: 1 }],
    ["max_iterations", { max_iterations: 51 }],
  ];

  for (const [field, changed] of cases) {
    it(`invalidates agent cache when ${field} changes`, async () => {
      const cache = new MemoryWorkflowCache();
      const runtime = new ScriptRuntime([[complete('"ok"')], [complete('"changed"')]]);
      await new WorkflowEngine({ runtime, cache, runId: "same" }).run(parsed(agentSpec()));
      await new WorkflowEngine({ runtime, cache, runId: "same" }).run(parsed(agentSpec()));
      await new WorkflowEngine({ runtime, cache, runId: "same" }).run(parsed(agentSpec(changed)));
      expect(runtime.requests, field).toHaveLength(2);
    });
  }

  it("refuses output and cost atomically and retries a partial fanout", async () => {
    const refusing = new MemoryWorkflowCache({ refuseWrite: () => true });
    const scalar = new ScriptRuntime([[complete("one")], [complete("two")]]);
    const one = parsed({ meta: { name: "refusal" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] });
    await new WorkflowEngine({ runtime: scalar, cache: refusing, runId: "same" }).run(one);
    await new WorkflowEngine({ runtime: scalar, cache: refusing, runId: "same" }).run(one);
    expect(scalar.requests).toHaveLength(2);
    expect(refusing.totalSplit("same").inputTokens).toBe(0);

    const cache = new MemoryWorkflowCache();
    const fanout = new ScriptRuntime([
      [complete("a")],
      [{ status: "failed", output: "dead" }],
      [complete("a2")],
      [complete("b2")],
    ]);
    const parallel = parsed({ meta: { name: "partial" }, nodes: [{ id: "p", type: "parallel", branches: ["a", "b"] }] });
    await new WorkflowEngine({ runtime: fanout, cache, runId: "same" }).run(parallel);
    await new WorkflowEngine({ runtime: fanout, cache, runId: "same" }).run(parallel);
    expect(fanout.requests).toHaveLength(4);
  });

  it("keeps absent max_iterations out of the legacy agent cell hash", async () => {
    const cache = new MemoryWorkflowCache();
    const legacyHash = contentHash("legacy", null, "a", "agent", "x", null, null, null);
    cache.put("same", legacyHash, "a", "legacy-hit", null);
    const runtime = new ScriptRuntime([]);
    const result = await new WorkflowEngine({ runtime, cache, runId: "same" }).run(
      parsed({ meta: { name: "legacy" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] }),
    );
    expect(result.outputs.a).toBe("legacy-hit");
    expect(runtime.requests).toHaveLength(0);
  });

  it("shares nested cache while preserving the child spec namespace", async () => {
    const runtime = new ScriptRuntime([[complete("inner")]]);
    const cache = new MemoryWorkflowCache();
    const engine = new WorkflowEngine({
      runtime,
      cache,
      runId: "same",
      loader: () => ({ meta: { name: "child", version: 2 }, nodes: [{ id: "leaf", type: "agent", prompt: "x" }] }),
    });
    const outer = parsed({ meta: { name: "outer" }, nodes: [{ id: "sub", type: "workflow", ref: "child" }] });
    await engine.run(outer);
    await engine.run(outer);
    expect(runtime.requests).toHaveLength(1);
  });
});
