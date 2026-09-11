import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import {
  Budget,
  contentHash,
  MemoryWorkflowCache,
  parseAndValidate,
  QUOTA_EXHAUSTED,
  WorkflowEngine,
  WorkflowService,
  validateSpec,
  writeTiers,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
  type LeafSandboxHandle,
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

  // Issue #360 inverteu este contrato: 'retries' fora do intervalo num
  // stage de pipeline não clampa mais em execução (era o caso aqui) — é
  // recusado NA CARGA, mesma regra 0-3 do nó (tests/workflow-schema.test.ts
  // prova a mensagem e o campo qualificado).
  it("rejects an out-of-range pipeline stage 'retries' at validation, not a runtime clamp", () => {
    const bad = validateSpec({
      meta: { name: "pipeline-retries" },
      nodes: [{ id: "p", type: "pipeline", items: ["x"], stages: [{ prompt: "x", retries: 4 }] }],
    });
    expect(bad).toHaveProperty("issues");
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
    const budget = new Budget({
      poolWidth: Number.NaN,
      maxFanout: Number.NaN,
      lifetime: Number.NaN,
    });
    expect(budget.poolWidth).toBe(1);
    expect(budget.maxFanout).toBe(1);
    expect(budget.lifetimeRemaining).toBe(1);
    expect(() => {
      budget.checkFanout(1_000_000_000);
    }).toThrow();
  });
});

describe("workflow parallel null aggregation", () => {
  it("keeps a dead branch's null in position and exposes it to a downstream ${p} ref", async () => {
    const runtime = new ScriptRuntime([
      [complete("a")],
      [{ status: "failed", output: "dead" }],
      [complete("done")],
    ]);
    const workflow = parsed({
      meta: { name: "positional-null" },
      nodes: [
        { id: "p", type: "parallel", branches: ["a", "b"] },
        { id: "consumer", type: "agent", prompt: "${p}", retries: 0 },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(workflow);
    expect(result.outputs.p).toEqual(["a", null]);
    expect(runtime.requests[2]?.prompt).toBe(JSON.stringify(["a", null]));
  });

  it("counts a fully dead branch group as one null node with a named fault", async () => {
    const runtime = new ScriptRuntime([
      [{ status: "failed", output: "dead-a" }],
      [{ status: "failed", output: "dead-b" }],
    ]);
    const workflow = parsed({
      meta: { name: "all-dead" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b"] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(workflow);
    expect(result.outputs.p).toBeNull();
    expect(result.nullCount).toBe(1);
    expect(result.faults).toContain("p: all 2 branches failed");
  });

  it("never filters nulls out of the parallel output array", async () => {
    const runtime = new ScriptRuntime([
      [{ status: "failed", output: "dead" }],
      [complete("b")],
      [{ status: "failed", output: "dead" }],
    ]);
    const workflow = parsed({
      meta: { name: "no-filtering" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b", "c"] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(workflow);
    expect(result.outputs.p).toHaveLength(3);
    expect(result.outputs.p).toEqual([null, "b", null]);
  });

  it("keeps an empty branch group as [] without a fault (every() is vacuously true)", async () => {
    const runtime = new ScriptRuntime([]);
    const workflow = parsed({
      meta: { name: "empty-group" },
      nodes: [{ id: "p", type: "parallel", branches: [] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(workflow);
    expect(result.outputs.p).toEqual([]);
    expect(result.nullCount).toBe(0);
    expect(result.faults).toEqual([]);
    expect(result.status).toBe("complete");
  });

  it("does not fault a fully-null group caused by run-level pause/cancellation", async () => {
    const runtime = new ScriptRuntime([
      [{ status: "failed", output: "quota", errorKind: QUOTA_EXHAUSTED }],
      [complete("unreachable")],
    ]);
    const workflow = parsed({
      meta: { name: "paused-mid-parallel" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b"] }],
    });
    const result = await new WorkflowEngine({
      runtime,
      budget: new Budget({ poolWidth: 1 }),
    }).run(workflow);
    expect(result.outputs.p).toEqual([null, null]);
    expect(result.faults).not.toContain("p: all 2 branches failed");
    expect(result.status).toBe("paused");
    expect(runtime.requests).toHaveLength(1);
  });
});

describe("workflow Draft 2020-12 output validation", () => {
  const rejected: readonly [unknown, Readonly<Record<string, unknown>>][] = [
    [1, { type: "number", minimum: 10 }],
    [
      { known: true, extra: true },
      { type: "object", properties: { known: { type: "boolean" } }, additionalProperties: false },
    ],
    [JSON.stringify("abc"), { type: "string", pattern: "^z+$" }],
    [[1], { type: "array", minItems: 2 }],
    [3, { oneOf: [{ type: "string" }, { type: "number", minimum: 5 }] }],
    [{ a: 1 }, { type: "object", dependentSchemas: { a: { required: ["b"] } } }],
    [{ BAD: 1 }, { type: "object", propertyNames: { pattern: "^[a-z]+$" } }],
    [
      { a: 1, b: 2 },
      { type: "object", properties: { a: { type: "number" } }, unevaluatedProperties: false },
    ],
  ];

  for (const [value, schema] of rejected) {
    it(`rejects ${JSON.stringify(value)} against ${JSON.stringify(schema)}`, () => {
      expect(parseAndValidate(value, schema).ok).toBe(false);
    });
  }

  it("resolves local anchors for valid and invalid values", () => {
    const schema = {
      $defs: { positive: { $anchor: "positive", type: "integer", minimum: 1 } },
      $ref: "#positive",
    };
    expect(parseAndValidate(2, schema).ok).toBe(true);
    expect(parseAndValidate(0, schema).ok).toBe(false);
  });

  it("resolves a local dynamic anchor for object and array values", () => {
    const schema = {
      $defs: { node: { $dynamicAnchor: "node", type: "object" } },
      $dynamicRef: "#node",
    };
    expect(parseAndValidate({}, schema).ok).toBe(true);
    expect(parseAndValidate([], schema).ok).toBe(false);
  });

  it("resolves an embedded id without external lookup", () => {
    const schema = {
      $defs: { foo: { $id: "urn:example:foo", type: "integer" } },
      $ref: "urn:example:foo",
    };
    expect(parseAndValidate(2, schema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify("2"), schema).ok).toBe(false);
  });

  it("keeps JSON Pointer refs and names unresolved refs without fetching", () => {
    const pointer = { $defs: { text: { type: "string" } }, $ref: "#/$defs/text" };
    expect(parseAndValidate(JSON.stringify("ok"), pointer).ok).toBe(true);
    expect(parseAndValidate(2, pointer).ok).toBe(false);
    for (const $ref of ["#missing", "https://example.invalid/schema"]) {
      const result = parseAndValidate(2, { $ref });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("schema error");
    }
  });

  for (const [value, accepted] of [
    [0.2, true],
    [0.3, false],
    [0.6, false],
    [0.7, false],
    [1.5, true],
  ] as const) {
    it(`matches pinned multipleOf arithmetic for ${String(value)}`, () => {
      expect(parseAndValidate(value, { type: "number", multipleOf: 0.1 }).ok).toBe(accepted);
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
        nodes: [
          { id: "a", type: "agent", prompt: "x", schema: { type: "object", required: ["value"] } },
        ],
      }),
    );
    expect(runtime.steers).toHaveLength(2);
    expect(result.validationRetries).toBe(2);
    expect(result.tokensIn).toBe(8);
    expect(result.tokensOut).toBe(13);
  });

  it("uses the leaf timeout default, accepts an override and cancels expiry", async () => {
    const runtime = new ScriptRuntime([[{ status: "running", output: null }], [complete("ok")]]);
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
    const one = parsed({
      meta: { name: "refusal" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    await new WorkflowEngine({ runtime: scalar, cache: refusing, runId: "same" }).run(one);
    await new WorkflowEngine({ runtime: scalar, cache: refusing, runId: "same" }).run(one);
    expect(scalar.requests).toHaveLength(2);
    expect(refusing.totalSplit("same").inputTokens).toBe(0);

    // #241: 1 of 3 branches dead — resume respawns only that one; its real
    // cost is what a later full-group cache hit replays (run 3), once (#305).
    const cache = new MemoryWorkflowCache();
    const fanout = new ScriptRuntime([
      [complete("a")],
      [{ status: "failed", output: "dead" }],
      [complete("c")],
      [complete("b2")],
    ]);
    const parallel = parsed({
      meta: { name: "partial" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b", "c"] }],
    });
    const run1 = await new WorkflowEngine({ runtime: fanout, cache, runId: "same" }).run(parallel);
    expect(fanout.requests).toHaveLength(3);
    expect(run1.nodeCosts.p?.usage.inputTokens).toBe(2);
    expect(cache.totalSplit("same").inputTokens).toBe(2);
    const run2 = await new WorkflowEngine({ runtime: fanout, cache, runId: "same" }).run(parallel);
    expect(fanout.requests).toHaveLength(4);
    expect(run2.nodeCosts.p?.usage.inputTokens).toBe(3);
    expect(cache.totalSplit("same").inputTokens).toBe(3); // not 6 — no double-record
    const run3 = await new WorkflowEngine({ runtime: fanout, cache, runId: "same" }).run(parallel);
    expect(fanout.requests).toHaveLength(4);
    expect(run3.nodeCosts.p?.usage.inputTokens).toBe(3);
    expect(cache.totalSplit("same").inputTokens).toBe(3);
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
      loader: () => ({
        meta: { name: "child", version: 2 },
        nodes: [{ id: "leaf", type: "agent", prompt: "x" }],
      }),
    });
    const outer = parsed({
      meta: { name: "outer" },
      nodes: [{ id: "sub", type: "workflow", ref: "child" }],
    });
    await engine.run(outer);
    await engine.run(outer);
    expect(runtime.requests).toHaveLength(1);
  });
});

// Shared below (#240, #239, #241): durable run/resume via `WorkflowService`.
const workflowResumeRoots: string[] = [];

afterEach(() => {
  while (workflowResumeRoots.length > 0)
    rmSync(workflowResumeRoots.pop() as string, { recursive: true, force: true });
});

function workflowResumeRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  workflowResumeRoots.push(path);
  return path;
}

function durableWorkflowService(
  home: string,
  runtime: ChildRuntime,
  extra: { readonly policyPath?: string; readonly tiersPath?: string } = {},
): { readonly service: WorkflowService; readonly close: () => void } {
  const connection = openStateDatabase(join(home, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const service = new WorkflowService({
    runtime,
    homeRoot: home,
    ...extra,
    store: {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
      database: connection.database,
    },
  });
  return {
    service,
    close: () => {
      connection.close();
    },
  };
}

// Issue #240: the cell key never includes operator policy, only the tier
// map (via `routingIdentity`) — exercised through the real durable path.
describe("workflow policy vs tier map — cache invalidation contract (#240)", () => {
  function recordingRuntime(): ChildRuntime & { readonly requests: ChildSpawnRequest[] } {
    const requests: ChildSpawnRequest[] = [];
    return {
      requests,
      spawn(request: ChildSpawnRequest): string {
        requests.push(request);
        return `leaf-${String(requests.length)}`;
      },
      collect: (): ChildResult => complete("ok"),
      steer: (): void => undefined,
      cancel: (): void => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
    };
  }

  // node "a" runs BEFORE the checkpoint (so it is already cached when the
  // operator edits config and resumes); node "b" only runs AFTER — proving
  // which cell survives and which one was ever supposed to be fresh.
  function twoStageSpec(): Record<string, unknown> {
    return {
      meta: { name: "policy-vs-tiers" },
      nodes: [
        { id: "a", type: "agent", prompt: "first", tier: "big" },
        { id: "cp", type: "checkpoint", prompt: "continue?", default: "yes" },
        { id: "b", type: "agent", prompt: "second" },
      ],
    };
  }

  it("changing the operator policy between run and resume never re-spawns the intact cell (#240)", async () => {
    const home = workflowResumeRoot("lohra-hardening-policy-");
    const policyPath = join(home, "workflow_policy.json");
    const dirA = join(home, "allow-a");
    const dirB = join(home, "allow-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(policyPath, JSON.stringify({ fs_allow: [dirA], egress_allow: [] }));
    const runtime = recordingRuntime();
    const { service, close } = durableWorkflowService(home, runtime, { policyPath });
    try {
      const started = service.start(twoStageSpec());
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(runtime.requests).toHaveLength(1);
      // policy A is live on THIS stretch: dirA allowed, dirB denied.
      const dispatchBeforeResume = service.leafToolDispatch(
        started.run_id,
        (name) => `allowed:${name}`,
      );
      expect(dispatchBeforeResume("read_file", { path: join(dirA, "x.txt") })).toBe(
        "allowed:read_file",
      );
      expect(dispatchBeforeResume("read_file", { path: join(dirB, "x.txt") })).toBe(
        "ERROR: path is outside the workflow working scope (sandbox denied)",
      );
      // the operator swaps the allowlist — same PATH, entirely different content
      writeFileSync(policyPath, JSON.stringify({ fs_allow: [dirB], egress_allow: [] }));
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      // policy B is live on the NEW stretch: inverted from before.
      const dispatchAfterResume = service.leafToolDispatch(
        started.run_id,
        (name) => `allowed:${name}`,
      );
      expect(dispatchAfterResume("read_file", { path: join(dirB, "x.txt") })).toBe(
        "allowed:read_file",
      );
      expect(dispatchAfterResume("read_file", { path: join(dirA, "x.txt") })).toBe(
        "ERROR: path is outside the workflow working scope (sandbox denied)",
      );
      // yet "a" was never re-spawned: exactly two requests total (a, then b).
      expect(runtime.requests).toHaveLength(2);
      expect(runtime.requests[0]?.prompt).toBe("first");
      expect(runtime.requests[1]?.prompt).toBe("second");
    } finally {
      close();
    }
  });

  it("changing the tier map for a node's tier between run and resume DOES invalidate the cell — routingIdentity resolves into the hash, correct behavior (#240, #258)", async () => {
    const home = workflowResumeRoot("lohra-hardening-policy-");
    const tiersPath = join(home, "workflow_tiers.json");
    writeTiers(tiersPath, { big: { model: "model-v1" } });
    const runtime = recordingRuntime();
    const { service, close } = durableWorkflowService(home, runtime, { tiersPath });
    try {
      const started = service.start(twoStageSpec());
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(runtime.requests).toHaveLength(1);
      expect(runtime.requests[0]?.model).toBe("model-v1");
      // the operator remaps the SAME tier name to a different model
      writeTiers(tiersPath, { big: { model: "model-v2" } });
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      // "a" IS re-spawned under the new mapping: three requests total.
      expect(runtime.requests).toHaveLength(3);
      expect(runtime.requests[0]?.prompt).toBe("first");
      expect(runtime.requests[0]?.model).toBe("model-v1");
      expect(runtime.requests[1]?.prompt).toBe("first");
      expect(runtime.requests[1]?.model).toBe("model-v2");
      expect(runtime.requests[2]?.prompt).toBe("second");
    } finally {
      close();
    }
  });
});

// Issue #239: `completeness_check`/`checkpoint` are cached cells —
// determinism across a resume is a CONSEQUENCE of the run-scoped cache, not
// a guard of its own. Pinned through the same durable `WorkflowService` path.
describe("checkpoint/resume verdict parity (#239)", () => {
  // Records every spawn and scripts a DIFFERENT output the second time the
  // SAME cell (by causalContext.cellId) is spawned — so a wrongful re-spawn
  // on resume is observable both as an extra request AND as a changed value
  // downstream, not just as a request-count coincidence.
  function verdictRuntime(): ChildRuntime & { readonly requests: ChildSpawnRequest[] } {
    const requests: ChildSpawnRequest[] = [];
    const seenCount = new Map<string, number>();
    const scripted = new Map<string, unknown>();
    return {
      requests,
      spawn(request: ChildSpawnRequest): string {
        requests.push(request);
        const id = `leaf-${String(requests.length)}`;
        const cellId = request.causalContext.cellId;
        const count = (seenCount.get(cellId) ?? 0) + 1;
        seenCount.set(cellId, count);
        scripted.set(
          id,
          count === 1 ? { complete: false, missing: ["docs"] } : { complete: true, missing: [] },
        );
        return id;
      },
      collect: (id: string): ChildResult => complete(scripted.get(id) ?? "ok"),
      steer: (): void => undefined,
      cancel: (): void => undefined,
      installLeafSandbox: (): LeafSandboxHandle => ({ dispose: (): void => undefined }),
    };
  }

  function completenessSpec(): Record<string, unknown> {
    return {
      meta: { name: "completeness-resume" },
      nodes: [
        { id: "c", type: "completeness_check", task: "ship", results: ["code"] },
        { id: "cp", type: "checkpoint", prompt: "continue?", default: "yes", depends_on: ["c"] },
        { id: "b", type: "agent", prompt: "second: ${c.complete}", depends_on: ["cp"] },
      ],
    };
  }

  it("completeness_check verdict survives a resume with no new spawn of that cell (#239 AC a)", async () => {
    const home = workflowResumeRoot("lohra-hardening-checkpoint-");
    const runtime = verdictRuntime();
    const { service, close } = durableWorkflowService(home, runtime);
    try {
      const started = service.start(completenessSpec());
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(paused.pause_reason).toBe("checkpoint");
      expect(runtime.requests).toHaveLength(1);
      // resume takes the checkpoint's default — no checkpoint_answers passed.
      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      // "c" is NOT re-spawned: two requests total (c, then b). Three would
      // mean the resume re-ran the completeness cell from scratch.
      expect(runtime.requests).toHaveLength(2);
      // "b" observes the verdict "c" resolved with BEFORE the pause (false),
      // never the scripted second-spawn value (true) a re-spawn would leak.
      expect(runtime.requests[1]?.prompt).toBe("second: false");
    } finally {
      close();
    }
  });

  function checkpointDurabilitySpec(): Record<string, unknown> {
    return {
      meta: { name: "checkpoint-answer-durable" },
      nodes: [
        { id: "a", type: "agent", prompt: "alpha" },
        { id: "cp1", type: "checkpoint", prompt: "first?", depends_on: ["a"] },
        { id: "b", type: "agent", prompt: "beta", depends_on: ["cp1"] },
        { id: "cp2", type: "checkpoint", prompt: "second?", depends_on: ["b"] },
        { id: "final", type: "agent", prompt: "gamma: ${cp1} then ${cp2}", depends_on: ["cp2"] },
      ],
    };
  }

  it("a checkpoint's recorded answer survives a LATER resume that omits it (#239 AC b)", async () => {
    const home = workflowResumeRoot("lohra-hardening-checkpoint-");
    const runtime = verdictRuntime();
    const { service, close } = durableWorkflowService(home, runtime);
    try {
      const started = service.start(checkpointDurabilitySpec());
      if ("error" in started) throw new Error(started.error);
      const firstPause = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(firstPause.status).toBe("paused");
      expect(runtime.requests).toHaveLength(1); // only "a"

      const resume1 = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          checkpointAnswers: { cp1: "go1" },
        },
      );
      if ("error" in resume1) throw new Error(resume1.error);
      const secondPause = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(secondPause.status).toBe("paused");
      expect(runtime.requests).toHaveLength(2); // "a" cached, "b" fresh

      // resume #2 answers ONLY cp2 — cp1's answer is not repeated here, yet
      // the durable cell recorded for cp1 in resume #1 must still resolve.
      const resume2 = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          checkpointAnswers: { cp2: "go2" },
        },
      );
      if ("error" in resume2) throw new Error(resume2.error);
      const final = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      expect(runtime.requests).toHaveLength(3); // a, b, final — no re-spawn
      expect(runtime.requests[2]?.prompt).toBe("gamma: go1 then go2");
    } finally {
      close();
    }
  });

  function undefaultedCheckpointSpec(): Record<string, unknown> {
    return {
      meta: { name: "checkpoint-no-default" },
      nodes: [{ id: "cp", type: "checkpoint", prompt: "answer me" }],
    };
  }

  it("a resume without an answer and without a default stays paused, unmodified (#239 AC c)", async () => {
    const home = workflowResumeRoot("lohra-hardening-checkpoint-");
    const runtime = verdictRuntime();
    const { service, close } = durableWorkflowService(home, runtime);
    try {
      const started = service.start(undefaultedCheckpointSpec());
      if ("error" in started) throw new Error(started.error);
      const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(paused.pause_reason).toBe("checkpoint");

      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      expect("error" in resumed).toBe(true);
      if ("error" in resumed) expect(resumed.error).toContain("waiting for an answer");

      // the refused resume never touched the run: still paused, same reason.
      const still = (await service.status(started.run_id, true)) as Record<string, unknown>;
      expect(still.status).toBe("paused");
      expect(still.pause_reason).toBe("checkpoint");
      expect(runtime.requests).toHaveLength(0);
    } finally {
      close();
    }
  });
});
