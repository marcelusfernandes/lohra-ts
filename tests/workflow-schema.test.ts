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
