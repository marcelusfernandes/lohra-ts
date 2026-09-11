import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MemoryWorkflowCache,
  NODE_SPECS,
  WorkflowEngine,
  isValidationError,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

// Issue #238: four fields (`min_success_ratio`, `loop_until_dry.budget`,
// `label`, `phase`) validated but had no reader in `src/`, and
// `stages[*]`/`body`/`synthesize`/`branches[*]` accepted any key — a routing
// knob one level down was silently ignored (`builtin-definitions.ts:445`).
// This file proves each field now either does something real or is refused.

class FakeRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
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

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

const complete = (output: unknown, inputTokens = 1, outputTokens = 1): ChildResult => ({
  status: "complete",
  output,
  usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  provider: "stub",
  model: "canned",
});

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if (isValidationError(result)) throw new Error(result.message);
  return result;
}

describe("min_success_ratio has a real reader (#238)", () => {
  it("seals the run failed when completion undershoots the ratio, citing measured vs required", async () => {
    const runtime = new FakeRuntime([[complete("ok")], [complete("")]]);
    const spec = parsed({
      meta: { name: "ratio-breach" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a", "b"],
          stages: [{ prompt: "${item}", retries: 0 }],
          min_success_ratio: 0.9,
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("failed");
    expect(
      result.faults.some((fault) => fault.includes("min_success_ratio") && fault.includes("50.0%")),
    ).toBe(true);
  });

  it("does not seal the run when the ratio is met", async () => {
    const runtime = new FakeRuntime([[complete("ok")], [complete("")]]);
    const spec = parsed({
      meta: { name: "ratio-met" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a", "b"],
          stages: [{ prompt: "${item}", retries: 0 }],
          min_success_ratio: 0.5,
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    // "degraded", not "complete": item "b"'s empty output after its one
    // (retries: 0) attempt still records its own fault — a real fault
    // unrelated to the ratio, which met its floor exactly (1/2 >= 0.5).
    expect(result.status).toBe("degraded");
  });

  it("rejects a ratio outside (0, 1]", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a"],
          stages: [{ prompt: "x" }],
          min_success_ratio: 0,
        },
      ],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "field_value",
      field: "min_success_ratio",
    });
  });
});

describe("loop_until_dry.budget is a real per-node token ceiling (#238)", () => {
  it("stops the round loop once spend reaches the budget, with a named fault", async () => {
    const runtime = new FakeRuntime([[complete("r0", 1, 1)]]);
    const spec = parsed({
      meta: { name: "loop-budget" },
      nodes: [
        {
          id: "l",
          type: "loop_until_dry",
          body: { prompt: "round ${round}" },
          stop_after_k_empty: 1,
          max_rounds: 5,
          budget: 2,
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.l).toEqual(["r0"]);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.faults.some((fault) => fault.includes("node budget exhausted"))).toBe(true);
  });

  it("rejects a non-positive or fractional budget", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "l",
          type: "loop_until_dry",
          body: { prompt: "x" },
          stop_after_k_empty: 1,
          max_rounds: 1,
          budget: 0.5,
        },
      ],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "field_value",
      field: "budget",
    });
  });

  // PR #341 review, round 1: reaching the budget on what would have been
  // the LAST round anyway (max_rounds hit) stopped nothing real — it must
  // not fault a run that otherwise completes cleanly.
  it("does not fault when the budget is reached on the last round anyway", async () => {
    const runtime = new FakeRuntime([[complete("r0", 1, 1)]]);
    const spec = parsed({
      meta: { name: "loop-budget-last-round" },
      nodes: [
        {
          id: "l",
          type: "loop_until_dry",
          body: { prompt: "round ${round}" },
          stop_after_k_empty: 1,
          max_rounds: 1,
          budget: 2,
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.faults.some((fault) => fault.includes("node budget exhausted"))).toBe(false);
  });

  // PR #341 review, round 1: `budget` was missing from the loop's cell
  // identity, so a re-run with a BIGGER budget replayed the earlier
  // truncated result from cache instead of running the extra rounds.
  it("re-runs instead of replaying a budget-truncated cache entry when budget grows", async () => {
    const cache = new MemoryWorkflowCache();
    const node = {
      id: "l",
      type: "loop_until_dry",
      body: { prompt: "round ${round}" },
      stop_after_k_empty: 1,
      max_rounds: 5,
    };
    const small = parsed({ meta: { name: "loop-budget-cache" }, nodes: [{ ...node, budget: 2 }] });
    const truncated = await new WorkflowEngine({
      runtime: new FakeRuntime([[complete("r0", 1, 1)]]),
      cache,
      runId: "same",
    }).run(small);
    expect(truncated.outputs.l).toEqual(["r0"]);

    const big = parsed({ meta: { name: "loop-budget-cache" }, nodes: [{ ...node, budget: 100 }] });
    const bigRuntime = new FakeRuntime([
      [complete("r0", 1, 1)],
      [complete("r1", 1, 1)],
      [complete("", 1, 1)],
    ]);
    const resumed = await new WorkflowEngine({ runtime: bigRuntime, cache, runId: "same" }).run(
      big,
    );
    // A stale cache hit would have replayed ["r0"] with zero new leaves.
    expect(bigRuntime.spawned.length).toBeGreaterThan(0);
    expect(resumed.outputs.l).toEqual(["r0", "r1"]);
  });
});

describe("'label' and 'phase' are refused, not silently accepted (#238)", () => {
  it.each(["label", "phase"])("names the removed field '%s' in the message", (field) => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "a", type: "agent", prompt: "x", [field]: "anything" }],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field,
      message: `'${field}' was removed; had no effect`,
    });
  });

  // A key straight off parsed JSON can be 'constructor' — that resolves
  // through the prototype chain of a plain `Object.freeze({...})` lookup
  // (freezing does not remove the prototype) to the `Object` FUNCTION, not
  // `undefined`, and a naive `REMOVED_FIELDS[key]` would hand that function
  // to `issue()` as `message` instead of falling through to the generic
  // 'has no field' wording.
  it("treats an unrelated key that collides with Object.prototype as a normal unknown field", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "a", type: "agent", prompt: "x", constructor: 1 }],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "constructor",
      message: "'agent' has no field 'constructor'",
    });
  });
});

describe("sub-object field validation (#238)", () => {
  // PR #341 review, round 1: a pipeline stage spawns its OWN leaf
  // (`runPipeline` in `engine.ts` merges the stage onto the node before
  // `collectLeaf`), so its own `model`/`tier`/`effort`/`provider` IS read —
  // unlike `body`/`synthesize`/`branches[*]`, which spawn with the outer
  // node and never see a stage-level routing knob. A stage still refuses
  // anything that isn't agent-shaped OR routing (a typo, say).
  it("accepts a routing knob inside a pipeline stage — it spawns its own leaf", () => {
    const good = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a"],
          stages: [{ prompt: "${item}", model: "gpt-4" }],
        },
      ],
    });
    expect(isValidationError(good)).toBe(false);
  });

  it("still rejects a typo'd field inside a pipeline stage", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a"],
          stages: [{ prompt: "${item}", modle: "gpt-4" }],
        },
      ],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "stages[0].modle",
    });
  });

  it("reads a pipeline stage's own routing knob for that stage's leaf request", async () => {
    const runtime = new FakeRuntime([[complete("done")]]);
    const spec = parsed({
      meta: { name: "stage-routing" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a"],
          stages: [{ prompt: "${item}", model: "gpt-4-stage" }],
        },
      ],
    });
    await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned[0]?.model).toBe("gpt-4-stage");
  });

  it("rejects a routing knob inside gate.body", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "g", type: "gate", body: { prompt: "x", tier: "big" }, validator: "review" }],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "body.tier",
    });
  });

  it("rejects a routing knob inside judge_panel.synthesize", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "j",
          type: "judge_panel",
          attempts: ["draft"],
          judges: 1,
          synthesize: { prompt: "polish ${winner}", provider: "openai" },
        },
      ],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "synthesize.provider",
    });
  });

  it("rejects a routing knob inside an object parallel branch, but leaves a plain string branch alone", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        { id: "p", type: "parallel", branches: [{ prompt: "x", model: "y" }, "plain string"] },
      ],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "branches[0].model",
    });
  });

  it("accepts every agent-shaped field in a pipeline stage", () => {
    const good = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "p",
          type: "pipeline",
          items: ["a"],
          stages: [
            {
              prompt: "${item}",
              schema: { type: "object" },
              tool_less: true,
              timeout: 5,
              retries: 1,
              max_iterations: 10,
            },
          ],
        },
      ],
    });
    expect(isValidationError(good)).toBe(false);
  });

  it("flags a non-object pipeline stage as a field_value error instead of skipping it silently (PR #262)", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "p", type: "pipeline", items: ["a"], stages: ["not-an-object"] }],
    });
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "field_value",
      field: "stages[0]",
    });
  });
});

describe("run_workflow description reflects the enforced contract (#238)", () => {
  const description = (): string => {
    const runWorkflow = BUILTIN_DEFINITIONS.find(
      (definition) => definition.function.name === "run_workflow",
    );
    if (runWorkflow === undefined) throw new Error("run_workflow tool not found");
    return runWorkflow.function.description;
  };

  it("no longer promises that a routing knob in a sub-object is silently ignored", () => {
    expect(description()).not.toContain("silently ignored");
  });

  it("documents min_success_ratio and budget as real caps", () => {
    expect(description()).toContain("min_success_ratio");
    expect(description()).toContain("'budget'");
  });
});

describe("NODE_SPECS anti-drift (#238)", () => {
  // `required` is the one declared field with no reader anywhere: inert by
  // design, pinned by `tests/workflow-executor.test.ts:184` and explicitly
  // out of scope for #238 ("Fora de escopo" in the issue body).
  const EXCEPTIONS = new Set(["required"]);

  // A bare `.<field>` substring is too loose — it matched `this.budget` (the
  // run-level Budget instance) for a `budget` that, before this issue, had
  // no reader at all. Every real read in `src/workflow/` goes through
  // `<something>.fields.<field>` (confirmed by hand for all ~30 fields when
  // this test was written) or, for an `Object.hasOwn` presence check, a
  // quoted string literal — a bare property-access match is not evidence.
  const readPattern = (field: string): RegExp =>
    new RegExp(`\\.fields\\.${field}\\b|["']${field}["']`);

  it("reads every field NODE_SPECS declares somewhere outside its own declaration", () => {
    const root = new URL("../src/workflow/", import.meta.url);
    const files = ["engine.ts", "engine-utils.ts", "schema.ts", "types.ts", "graph.ts", "refs.ts"];
    const source = files
      .map((file) => readFileSync(fileURLToPath(new URL(file, root)), "utf8"))
      .join("\n");
    const fields = new Set<string>();
    for (const spec of Object.values(NODE_SPECS)) {
      for (const field of spec.fields) fields.add(field);
    }
    const missing = [...fields].filter(
      (field) => !EXCEPTIONS.has(field) && !readPattern(field).test(source),
    );
    expect(missing).toEqual([]);
  });
});
