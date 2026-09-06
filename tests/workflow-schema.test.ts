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
        "    e.g. allowed: ['depends_on', 'effort', 'label', 'max_iterations', 'model', 'phase', 'prompt', 'provider', 'required', 'retries', 'schema', 'schema_ref', 'tier', 'timeout', 'tool_less']",
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
