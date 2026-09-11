import { describe, expect, it } from "vitest";

import {
  MAX_GATE_ATTEMPTS,
  MAX_NODE_MAX_ITERATIONS,
  MAX_NODE_RETRIES,
  MAX_STATIC_FANOUT,
  NODE_SPECS,
  NODE_TYPES,
  ValidationError,
  isValidationError,
  validateNestedRefs,
  validateSpec,
} from "../src/workflow/index.js";

const agent = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a",
  type: "agent",
  prompt: "work",
  ...fields,
});

describe("workflow node registry", () => {
  it("keeps the closed ten-type registry and boundaries", () => {
    expect([...NODE_TYPES].sort()).toEqual([
      "agent",
      "checkpoint",
      "completeness_check",
      "gate",
      "judge_panel",
      "loop_until_dry",
      "parallel",
      "pipeline",
      "verify",
      "workflow",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(NODE_SPECS).map(([name, spec]) => [
          name,
          {
            required: [...spec.required].sort(),
            routing: ["model", "tier", "effort", "provider"].every((field) =>
              spec.fields.includes(field),
            ),
          },
        ]),
      ),
    ).toMatchObject({
      agent: { required: ["prompt"], routing: true },
      checkpoint: { required: ["prompt"], routing: false },
      completeness_check: { required: ["results", "task"], routing: true },
      gate: { required: ["body", "validator"], routing: true },
      judge_panel: { required: ["attempts", "judges", "synthesize"], routing: true },
      loop_until_dry: {
        required: ["body", "max_rounds", "stop_after_k_empty"],
        routing: true,
      },
      parallel: { required: ["branches"], routing: false },
      pipeline: { required: ["items", "stages"], routing: false },
      verify: { required: ["finding", "skeptics"], routing: true },
      workflow: { required: ["ref"], routing: false },
    });
    expect({
      MAX_STATIC_FANOUT,
      MAX_NODE_RETRIES,
      MAX_GATE_ATTEMPTS,
      MAX_NODE_MAX_ITERATIONS,
    }).toEqual({
      MAX_STATIC_FANOUT: 64,
      MAX_NODE_RETRIES: 3,
      MAX_GATE_ATTEMPTS: 3,
      MAX_NODE_MAX_ITERATIONS: 128,
    });
  });
});

describe("validateSpec", () => {
  it("returns a defensive frozen spec and preserves required truthiness", () => {
    const raw = {
      meta: { name: "demo", tags: ["a"] },
      inputs: { topic: { type: "string" } },
      schemas: { OUT: { type: "object" } },
      nodes: [agent({ required: "false", depends_on: [] })],
    };
    const result = validateSpec(raw);
    expect(isValidationError(result)).toBe(false);
    if (isValidationError(result)) throw new Error(result.message);
    expect(result.nodes[0]?.required).toBe(true);
    raw.meta.tags.push("mutated");
    (raw.nodes[0]?.depends_on as string[]).push("mutated");
    expect(result.meta.tags).toEqual(["a"]);
    expect(result.nodes[0]?.fields.depends_on).toEqual([]);
    expect(Object.isFrozen(result.meta.tags)).toBe(true);
    expect(() => {
      (result.meta.tags as string[]).push("blocked");
    }).toThrow();
  });

  it.each([
    ["array", []],
    ["object", {}],
  ])("never throws for an unhashable-like node type: %s", (_label, type) => {
    const result = validateSpec({ meta: { name: "x" }, nodes: [{ id: "a", type }] });
    expect(result).toBeInstanceOf(ValidationError);
    expect(isValidationError(result) && result.issues[0]).toMatchObject({
      rule: "node_type",
      nodeId: "a",
      field: "type",
      message: `unknown node type ${JSON.stringify(type)}`,
    });
  });

  // Round 2 (PR #85 review): the array/object cases above render identically
  // under the old pythonRepr and the new JSON.stringify ("[]" and "{}" have
  // no quote/None divergence) — they never actually pinned the JSON switch.
  // These three distinguish: a string cites with double quotes (was single),
  // null cites as the JSON literal `null` (was `None`), and a missing type
  // cites as the JS-native `undefined` (was also `None`).
  it("cites an unknown string node type with double quotes, never Python's single quotes", () => {
    const result = validateSpec({ meta: { name: "x" }, nodes: [{ id: "a", type: "bogus" }] });
    expect(result).toBeInstanceOf(ValidationError);
    expect(isValidationError(result) && result.issues[0]).toMatchObject({
      rule: "node_type",
      nodeId: "a",
      field: "type",
      message: 'unknown node type "bogus"',
    });
  });

  it("cites a null node type as the JSON literal null, never Python's None", () => {
    const result = validateSpec({ meta: { name: "x" }, nodes: [{ id: "a", type: null }] });
    expect(result).toBeInstanceOf(ValidationError);
    expect(isValidationError(result) && result.issues[0]).toMatchObject({
      rule: "node_type",
      nodeId: "a",
      field: "type",
      message: "unknown node type null",
    });
  });

  it("cites a missing node type as the literal undefined, never Python's None", () => {
    const result = validateSpec({ meta: { name: "x" }, nodes: [{ id: "a" }] });
    expect(result).toBeInstanceOf(ValidationError);
    expect(isValidationError(result) && result.issues[0]).toMatchObject({
      rule: "node_type",
      nodeId: "a",
      field: "type",
      message: "unknown node type undefined",
    });
  });

  it("normalizes non-object inputs silently and renders one issue byte-exactly", () => {
    const valid = validateSpec({ meta: { name: "x" }, inputs: [], nodes: [agent()] });
    expect(isValidationError(valid)).toBe(false);
    if (!isValidationError(valid)) expect(valid.inputs).toEqual({});

    const invalid = validateSpec({
      meta: { name: "x" },
      nodes: [agent({ bogus: true })],
    });
    expect(isValidationError(invalid)).toBe(true);
    if (!isValidationError(invalid)) throw new Error("expected validation error");
    expect(invalid.message).toBe(
      "[unknown_field] a .bogus: 'agent' has no field 'bogus'\n" +
        "    e.g. allowed: ['depends_on', 'effort', 'max_iterations', 'model', 'prompt', 'provider', 'required', 'retries', 'schema', 'schema_ref', 'tier', 'timeout', 'tool_less']",
    );
  });

  it("validates lifecycle, tier, gate and fanout boundaries", () => {
    const good = validateSpec({
      meta: { name: "x" },
      nodes: [
        agent({ retries: 0, timeout: 0.5, max_iterations: 128, tier: "big" }),
        {
          id: "g",
          type: "gate",
          body: { prompt: 123 },
          validator: "review",
          attempts: 3,
        },
        { id: "p", type: "parallel", branches: Array.from({ length: 64 }, () => "x") },
      ],
    });
    expect(isValidationError(good)).toBe(false);

    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        agent({ retries: true, timeout: 0, max_iterations: 129, tier: "huge" }),
        { id: "g", type: "gate", body: { prompt: false }, validator: 123, attempts: 4 },
        { id: "p", type: "parallel", branches: Array.from({ length: 65 }, () => "x") },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues.map((issue) => [issue.rule, issue.field])).toEqual([
      ["field_value", "timeout"],
      ["field_value", "retries"],
      ["field_value", "max_iterations"],
      ["field_value", "tier"],
      ["field_value", "body"],
      ["field_value", "validator"],
      ["field_value", "attempts"],
      ["fanout_cap", null],
    ]);
  });

  it("validates and accepts 'retries' on a parallel node (#242)", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 4 }],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues.map((issue) => [issue.rule, issue.field])).toEqual([
      ["field_value", "retries"],
    ]);

    const good = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 2 }],
    });
    expect(isValidationError(good)).toBe(false);
  });

  it("accepts a named 'schema' string that matches a top-level schemas entry", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [agent({ schema: "FINDING" })],
    });
    expect(isValidationError(result)).toBe(false);
  });

  it("rejects a named 'schema' string with no matching entry in schemas, same as schema_ref", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [agent({ schema: "MISSING" })],
    });
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues[0]).toMatchObject({ rule: "schema_type", field: "schema" });
  });

  it("rejects a 'schema_ref' with no matching entry inside body/synthesize/stages sub-objects", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", schema_ref: "TYPO" },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
        {
          id: "gate",
          type: "gate",
          body: { prompt: "x", schema_ref: "TYPO" },
          validator: "review",
        },
        {
          id: "panel",
          type: "judge_panel",
          attempts: 1,
          judges: ["a"],
          synthesize: { prompt: "x", schema_ref: "TYPO" },
        },
        {
          id: "pipe",
          type: "pipeline",
          items: ["x"],
          stages: [{ prompt: "x", schema_ref: "TYPO" }],
        },
      ],
    });
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues.map((issue) => [issue.rule, issue.nodeId, issue.field])).toEqual([
      ["schema_ref", "loop", "body.schema_ref"],
      ["schema_ref", "gate", "body.schema_ref"],
      ["schema_ref", "panel", "synthesize.schema_ref"],
      ["schema_ref", "pipe", "stages[0].schema_ref"],
    ]);
  });

  it("rejects a 'schema' string with no matching entry inside a sub-object, same rule as schema_ref", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", schema: "TYPO" },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
      ],
    });
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues[0]).toMatchObject({
      rule: "schema_type",
      nodeId: "loop",
      field: "body.schema",
    });
  });

  it("rejects 'schema' and 'schema_ref' together in the same sub-object as schema_xor", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", schema: { type: "object" }, schema_ref: "FINDING" },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
      ],
    });
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues[0]).toMatchObject({
      rule: "schema_xor",
      nodeId: "loop",
      field: "body.schema_ref",
    });
  });

  it("accepts a valid named schema_ref in a sub-object (body, synthesize, and a pipeline stage)", () => {
    const result = validateSpec({
      meta: { name: "x" },
      schemas: { FINDING: { type: "object" } },
      nodes: [
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", schema_ref: "FINDING" },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
        {
          id: "panel",
          type: "judge_panel",
          attempts: 1,
          judges: ["a"],
          synthesize: { prompt: "x", schema: "FINDING" },
        },
        {
          id: "pipe",
          type: "pipeline",
          items: ["x"],
          stages: [{ prompt: "x", schema_ref: "FINDING" }],
        },
      ],
    });
    expect(isValidationError(result)).toBe(false);
  });

  // Issue #342 (PR #341 review, round 2): `validateTier` only ever read
  // `node.fields.tier` — a pipeline stage's OWN `tier` (`STAGE_FIELDS`
  // accepts it because a stage spawns its own leaf, `nodes.ts`) went
  // straight through with no enum check, so a typo like 'huge' validated
  // clean and silently fell back to the session's own model at runtime.
  it("rejects an out-of-enum 'tier' inside a pipeline stage, same rule as the node-level field", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        { id: "pipe", type: "pipeline", items: ["x"], stages: [{ prompt: "x", tier: "huge" }] },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "pipe",
      field: "stages[0].tier",
    });
  });

  it("accepts a valid enum 'tier' inside a pipeline stage", () => {
    const good = validateSpec({
      meta: { name: "x" },
      nodes: [
        { id: "pipe", type: "pipeline", items: ["x"], stages: [{ prompt: "x", tier: "big" }] },
      ],
    });
    expect(isValidationError(good)).toBe(false);
  });

  // Issue #360 (PR #358 review, #342): `validateSubObjectFields` only checked
  // NAMES — a sub-object's `retries`/`timeout`/`max_iterations`/`tool_less`
  // reached the leaf with no value check, so an out-of-range value clamped
  // or defaulted silently at runtime instead of failing at launch, the same
  // way an out-of-range value on the NODE already does.
  it("rejects an out-of-range 'retries' inside gate.body, same rule and message as the node", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [{ id: "g", type: "gate", body: { prompt: "x", retries: 9 }, validator: "review" }],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "g",
      field: "body.retries",
      message: "'retries' must be a whole number between 0 and 3",
    });
  });

  it("rejects a non-numeric 'timeout' inside loop_until_dry.body, same rule as the node", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", timeout: "300" },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "loop",
      field: "body.timeout",
      message: "'timeout' must be a positive number of seconds",
    });
  });

  it("rejects a non-integer 'max_iterations' inside a pipeline stage, same rule as the node", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "pipe",
          type: "pipeline",
          items: ["x"],
          stages: [{ prompt: "x", max_iterations: "x" }],
        },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "pipe",
      field: "stages[0].max_iterations",
      message: "'max_iterations' must be a whole number between 1 and 128",
    });
  });

  it("rejects a non-boolean 'tool_less' inside judge_panel.synthesize", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "panel",
          type: "judge_panel",
          attempts: 1,
          judges: ["a"],
          synthesize: { prompt: "x", tool_less: "yes" },
        },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "panel",
      field: "synthesize.tool_less",
      message: "'tool_less' must be true or false",
    });
  });

  it("rejects an out-of-range 'retries' inside an object parallel branch, and leaves a string branch untouched", () => {
    const bad = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "p",
          type: "parallel",
          branches: [{ prompt: "x", retries: -1 }, "plain string"],
        },
      ],
    });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "p",
      field: "branches[0].retries",
      message: "'retries' must be a whole number between 0 and 3",
    });
  });

  it("rejects a non-boolean node-level 'tool_less', the same rule sub-objects now share", () => {
    const bad = validateSpec({ meta: { name: "x" }, nodes: [agent({ tool_less: "yes" })] });
    expect(isValidationError(bad)).toBe(true);
    if (!isValidationError(bad)) throw new Error("expected validation error");
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "a",
      field: "tool_less",
      message: "'tool_less' must be true or false",
    });
  });

  it("accepts valid knob values in every agent-shaped sub-object at once", () => {
    const good = validateSpec({
      meta: { name: "x" },
      nodes: [
        {
          id: "g",
          type: "gate",
          body: { prompt: "x", retries: 2, timeout: 30, max_iterations: 5, tool_less: true },
          validator: "review",
        },
        {
          id: "loop",
          type: "loop_until_dry",
          body: { prompt: "x", retries: 0, timeout: 1, max_iterations: 1, tool_less: false },
          stop_after_k_empty: 1,
          max_rounds: 3,
        },
        {
          id: "panel",
          type: "judge_panel",
          attempts: 1,
          judges: ["a"],
          synthesize: {
            prompt: "x",
            retries: 3,
            timeout: 600,
            max_iterations: 128,
            tool_less: true,
          },
        },
        {
          id: "p",
          type: "parallel",
          branches: [
            { prompt: "x", retries: 1, timeout: 10, max_iterations: 10, tool_less: false },
          ],
        },
      ],
    });
    expect(isValidationError(good)).toBe(false);
  });

  it("skips the sub-object schema scan (no throw, no schema_* issue) when body/synthesize/a stage is not a record", () => {
    const result = validateSpec({
      meta: { name: "x" },
      nodes: [
        { id: "loop", type: "loop_until_dry", body: "not an object", max_rounds: 3 },
        {
          id: "panel",
          type: "judge_panel",
          attempts: 1,
          judges: ["a"],
          synthesize: null,
        },
        { id: "pipe", type: "pipeline", items: ["x"], stages: ["not an object"] },
      ],
    });
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues.map((issue) => issue.rule)).not.toContain("schema_ref");
    expect(result.issues.map((issue) => issue.rule)).not.toContain("schema_type");
    expect(result.issues.map((issue) => issue.rule)).not.toContain("schema_xor");
  });

  it("keeps duplicate and invalid-node cascades observable", () => {
    const result = validateSpec(
      {
        meta: { name: "x" },
        nodes: [
          agent(),
          { id: "a", type: "agent", prompt: "duplicate", bogus: true },
          { id: "bad", type: "checkpoint", prompt: "x" },
          { id: "consumer", type: "agent", prompt: "${bad.value}" },
        ],
      },
      { supportedTypes: new Set(["agent"]) },
    );
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues.map((issue) => issue.rule)).toEqual([
      "unknown_field",
      "dup_id",
      "unsupported_type",
      "ref_target",
    ]);
  });
});

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if (isValidationError(result)) throw new Error(result.message);
  return result;
}

const outerWithRef = (ref: unknown = "inner") =>
  parsed({
    meta: { name: "outer" },
    nodes: [{ id: "nested", type: "workflow", ref, args: {} }],
  });

describe("validateNestedRefs (#244 — resolve a nested template on the parent's launch)", () => {
  it("passes a valid nested template through", () => {
    const loader = () => ({
      meta: { name: "inner" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    expect(validateNestedRefs(outerWithRef(), loader)).toBeNull();
  });

  it("refuses an invalid nested template, citing the node, the ref and #244", () => {
    const loader = () => ({
      meta: { name: "inner" },
      nodes: [{ id: "a", type: "agent", prompt: "x", unknown_field: true }],
    });
    const result = validateNestedRefs(outerWithRef(), loader);
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.issues[0]?.nodeId).toBe("nested");
    expect(result.issues[0]?.field).toBe("ref");
    expect(result.message).toContain("inner");
    expect(result.message).toContain("#244");
  });

  it("skips a ref built from a ${} expression — unresolvable before the run has context", () => {
    let calls = 0;
    const loader = () => {
      calls += 1;
      return { meta: { name: "inner" }, nodes: [] };
    };
    expect(validateNestedRefs(outerWithRef("${args.template}"), loader)).toBeNull();
    expect(calls).toBe(0);
  });

  it("skips a loader that answers asynchronously — the runtime backstop owns that path", async () => {
    const loader = () => Promise.resolve({ meta: { name: "inner" }, nodes: [] });
    expect(validateNestedRefs(outerWithRef(), loader)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("carries a loader failure into the launch refusal", () => {
    const loader = (): never => {
      throw new Error("disk unavailable");
    };
    const result = validateNestedRefs(outerWithRef(), loader);
    expect(isValidationError(result)).toBe(true);
    if (!isValidationError(result)) throw new Error("expected validation error");
    expect(result.message).toContain("disk unavailable");
  });

  it("stops at MAX_WORKFLOW_DEPTH without a second loader call — mirrors the engine's own cap", () => {
    const calls: string[] = [];
    const loader = (reference: string) => {
      calls.push(reference);
      return reference === "middle"
        ? { meta: { name: "middle" }, nodes: [{ id: "too-deep", type: "workflow", ref: "inner" }] }
        : { meta: { name: "inner" }, nodes: [] };
    };
    expect(validateNestedRefs(outerWithRef("middle"), loader)).toBeNull();
    expect(calls).toEqual(["middle"]);
  });

  it("does nothing without a loader", () => {
    expect(validateNestedRefs(outerWithRef(), undefined)).toBeNull();
  });
});
