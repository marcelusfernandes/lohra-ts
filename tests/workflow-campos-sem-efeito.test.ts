import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
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
    expect(result.status).not.toBe("failed");
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
});

describe("sub-object field validation (#238)", () => {
  it("rejects a routing knob inside a pipeline stage", () => {
    const bad = validateSpec({
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
    expect(isValidationError(bad) && bad.issues[0]).toMatchObject({
      rule: "unknown_field",
      field: "stages[0].model",
    });
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
      (field) => !EXCEPTIONS.has(field) && !source.includes(`.${field}`),
    );
    expect(missing).toEqual([]);
  });
});
