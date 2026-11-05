// Issue #980 (S3 do épico #976): a validação do nó `loop` — `body` (agent-shaped
// com `prompt`), `until` (um predicado do S1, com `last` permitido só ali) e
// `max_rounds` (inteiro obrigatório de 1 a 16). O corpo passa pelas mesmas regras
// de nome e de valor dos demais sub-objetos agent-shaped (`schemaBearingSubObjects`,
// `schema.ts`), um knob de roteamento só vale no nó, e o local `last` (a saída da
// rodada) existe apenas dentro de `until`: em qualquer outro lugar é um `ref_target`.
import { describe, expect, it } from "vitest";

import { topologicalOrder } from "../src/workflow/graph.js";
import { MAX_LOOP_ROUNDS, NODE_SPECS, NODE_TYPES } from "../src/workflow/nodes.js";
import { PREDICATE_NAMES } from "../src/workflow/predicates.js";
import { NODE_VALIDATORS, validateLoop } from "../src/workflow/schema-nodes.js";
import { validateSpec } from "../src/workflow/schema.js";
import { Node, type SpecIssue, ValidationError, WorkflowSpec } from "../src/workflow/types.js";

const UNTIL = { gte: { path: "${last.score}", n: 8 } };

const loop = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "refine",
  type: "loop",
  body: { prompt: "Improve ${args.text}" },
  until: UNTIL,
  max_rounds: 3,
  ...fields,
});

function issuesOf(nodes: readonly Record<string, unknown>[], extra = {}): readonly SpecIssue[] {
  const result = validateSpec({ meta: { name: "loop" }, nodes, ...extra });
  return result instanceof ValidationError ? result.issues : [];
}

const loopIssues = (fields: Record<string, unknown> = {}): readonly SpecIssue[] =>
  issuesOf([loop(fields)]);

const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(loop()).filter(([key]) => key !== field));

const summary = (issues: readonly SpecIssue[]): string[] =>
  issues.map((issue) => `${issue.rule}:${String(issue.field)}`);

describe("loop is a registered node type (#980)", () => {
  it("is one of the closed node types, with routing at the node and all three fields required", () => {
    expect(NODE_TYPES.has("loop")).toBe(true);
    const spec = NODE_SPECS.loop;
    expect([...(spec?.required ?? [])].sort()).toEqual(["body", "max_rounds", "until"]);
    for (const field of ["body", "until", "max_rounds", "model", "tier", "effort", "provider"])
      expect(spec?.fields).toContain(field);
    // The lifecycle knobs live in the body; `loop_until_dry`'s own fields are not this node's.
    for (const field of ["prompt", "timeout", "retries", "stop_after_k_empty", "budget"])
      expect(spec?.fields).not.toContain(field);
  });

  it("caps the rounds at 16 and registers its validator by type", () => {
    expect(MAX_LOOP_ROUNDS).toBe(16);
    expect(NODE_VALIDATORS.get("loop")).toBe(validateLoop);
  });

  it("validateLoop ignores every other node type", () => {
    const issues: SpecIssue[] = [];
    validateLoop(
      new Node("a", "agent", { prompt: "x", body: 1, until: 2, max_rounds: 99 }),
      issues,
    );
    expect(issues).toEqual([]);
  });
});

describe("a well formed loop validates (#980)", () => {
  it("accepts body + until + max_rounds", () => {
    const result = validateSpec({ meta: { name: "loop" }, nodes: [loop()] });
    expect(result).toBeInstanceOf(WorkflowSpec);
  });

  it("accepts the boundaries: exactly 1 and exactly MAX_LOOP_ROUNDS rounds", () => {
    expect(loopIssues({ max_rounds: 1 })).toEqual([]);
    expect(loopIssues({ max_rounds: MAX_LOOP_ROUNDS })).toEqual([]);
  });

  it("accepts node-level routing knobs, and a body with its own lifecycle knobs and schema", () => {
    expect(
      loopIssues({
        tier: "big",
        provider: "p",
        body: {
          prompt: "x",
          retries: 1,
          timeout: 30,
          max_iterations: 4,
          tool_less: true,
          schema: { type: "object" },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a body with a named schema_ref", () => {
    const result = validateSpec({
      meta: { name: "loop" },
      schemas: { DRAFT: { type: "object" } },
      nodes: [loop({ body: { prompt: "x", schema_ref: "DRAFT" } })],
    });
    expect(result).toBeInstanceOf(WorkflowSpec);
  });

  it("accepts every predicate of the S1 table as `until`", () => {
    const predicates: Record<(typeof PREDICATE_NAMES)[number], unknown> = {
      field_equals: { field_equals: { path: "${last.verdict}", value: "ok" } },
      field_true: { field_true: { path: "${last.ok}" } },
      in: { in: { path: "${last.verdict}", values: ["ok", "skip"] } },
      gte: { gte: { path: "${last.score}", n: 8 } },
      lt: { lt: { path: "${last.errors}", n: 1 } },
      count_gte: { count_gte: { path: "${last.items}", n: 3 } },
      empty: { empty: { path: "${last.problems}" } },
      field_type: { field_type: { path: "${last.score}", type: "number" } },
      not: { not: { of: { field_true: { path: "${last.failed}" } } } },
    };
    expect(Object.keys(predicates).sort()).toEqual([...PREDICATE_NAMES].sort());
    for (const [name, until] of Object.entries(predicates))
      expect(loopIssues({ until }), name).toEqual([]);
  });

  it("lets `until` read last, round, so_far, args and an upstream node", () => {
    const nodes = (until: unknown): readonly Record<string, unknown>[] => [
      { id: "scan", type: "agent", prompt: "scan" },
      loop({ until }),
    ];
    for (const path of [
      "${last.score}",
      "${last}",
      "${round}",
      "${so_far}",
      "${args.target}",
      "${scan.threshold}",
    ])
      expect(issuesOf(nodes({ field_true: { path } })), path).toEqual([]);
  });
});

describe("body must be an agent-shaped object (#980)", () => {
  it("is required", () => {
    expect(summary(issuesOf([without("body")]))).toEqual(["missing_field:body"]);
  });

  it.each([
    ["a string", "Improve it"],
    ["a list", [{ prompt: "x" }]],
    ["null", null],
    ["an empty object", {}],
    ["an object with a blank prompt", { prompt: "   " }],
    ["an object with a null prompt", { prompt: null }],
  ])("refuses %s, naming the field and an example", (_label, body) => {
    const mine = loopIssues({ body }).filter((issue) => issue.field === "body");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rule: "field_value", nodeId: "refine" });
    expect(mine[0]?.message).toContain("prompt");
    expect(mine[0]?.example).toContain("prompt");
  });

  it("checks the body's schema_ref and schema like any agent-shaped sub-object", () => {
    expect(summary(loopIssues({ body: { prompt: "x", schema_ref: "NOPE" } }))).toEqual([
      "schema_ref:body.schema_ref",
    ]);
    expect(
      summary(loopIssues({ body: { prompt: "x", schema: { type: "object" }, schema_ref: "X" } })),
    ).toContain("schema_xor:body.schema_ref");
    expect(summary(loopIssues({ body: { prompt: "x", schema: 4 } }))).toEqual([
      "schema_type:body.schema",
    ]);
  });

  it("checks the body's knob values with the qualified field", () => {
    expect(summary(loopIssues({ body: { prompt: "x", timeout: -1 } }))).toEqual([
      "field_value:body.timeout",
    ]);
    expect(summary(loopIssues({ body: { prompt: "x", retries: 9 } }))).toEqual([
      "field_value:body.retries",
    ]);
    expect(summary(loopIssues({ body: { prompt: "x", max_iterations: 0 } }))).toEqual([
      "field_value:body.max_iterations",
    ]);
  });

  it("refuses a routing knob inside the body: it goes on the node", () => {
    const issues = loopIssues({ body: { prompt: "x", model: "m" } });
    expect(summary(issues)).toEqual(["unknown_field:body.model"]);
    expect(issues[0]?.message).toContain("routing knobs go on the node");
  });
});

describe("until must be a valid predicate (#980)", () => {
  it("is required", () => {
    expect(summary(issuesOf([without("until")]))).toEqual(["missing_field:until"]);
  });

  it.each([
    ["a string", "approved"],
    ["a list", [UNTIL]],
    ["null", null],
    ["an empty object", {}],
    ["two predicates", { ...UNTIL, field_true: { path: "${last.ok}" } }],
  ])("refuses %s as `until`", (_label, until) => {
    const issues = loopIssues({ until });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "field_value", nodeId: "refine", field: "until" });
    expect(issues[0]?.example).toContain("field_true");
  });

  it("names an unknown predicate and says there is no and/or", () => {
    const issues = loopIssues({ until: { and: [UNTIL] } });
    expect(summary(issues)).toEqual(["unknown_field:until.and"]);
    expect(issues[0]?.message).toContain("chain nodes");
  });

  it("refuses a field the predicate does not have, and a missing one, extending `until`", () => {
    expect(
      summary(loopIssues({ until: { gte: { path: "${last.score}", n: 8, extra: 1 } } })),
    ).toEqual(["unknown_field:until.gte.extra"]);
    expect(summary(loopIssues({ until: { gte: { path: "${last.score}" } } }))).toEqual([
      "missing_field:until.gte.n",
    ]);
  });

  it("refuses a path that is not exactly one ${ref}", () => {
    for (const path of ["last.score", "score is ${last.score}", "${last.a}${last.b}", 3]) {
      const issues = loopIssues({ until: { field_true: { path } } });
      expect(summary(issues), String(path)).toEqual(["field_value:until.field_true.path"]);
    }
  });

  it("refuses a ${} inside an operand, a bad operand, and a not inside a not", () => {
    expect(
      summary(loopIssues({ until: { field_equals: { path: "${last.v}", value: "${args.x}" } } })),
    ).toEqual(["field_value:until.field_equals.value"]);
    expect(summary(loopIssues({ until: { gte: { path: "${last.v}", n: "8" } } }))).toEqual([
      "field_value:until.gte.n",
    ]);
    expect(
      summary(
        loopIssues({
          until: { not: { of: { not: { of: { field_true: { path: "${last.ok}" } } } } } },
        }),
      ),
    ).toEqual(["field_value:until.not.of.not"]);
  });

  it("an expression in a path is a ref_expression", () => {
    const issues = loopIssues({ until: { field_true: { path: "${last.a+1}" } } });
    expect(issues.map((issue) => issue.rule)).toContain("ref_expression");
  });
});

describe("max_rounds is a whole number from 1 to 16, and never defaulted (#980)", () => {
  it("is required", () => {
    expect(summary(issuesOf([without("max_rounds")]))).toEqual(["missing_field:max_rounds"]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["one past the cap", MAX_LOOP_ROUNDS + 1],
    ["a decimal", 2.5],
    ["a numeric string", "3"],
    ["null", null],
    ["a boolean", true],
    ["a list", [3]],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses %s, naming the field, the range and an example", (_label, maxRounds) => {
    const issues = loopIssues({ max_rounds: maxRounds });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule: "field_value",
      nodeId: "refine",
      field: "max_rounds",
    });
    expect(issues[0]?.message).toContain(`1 and ${String(MAX_LOOP_ROUNDS)}`);
    expect(issues[0]?.example).toContain("max_rounds");
  });
});

describe("`last` is a local of `until` and of nothing else (#980)", () => {
  const last = (field: string): Record<string, unknown> => ({ prompt: `Fix \${${field}}` });

  it("is refused in the body prompt, naming where it is allowed", () => {
    const issues = loopIssues({ body: last("last.draft") });
    expect(summary(issues)).toEqual(["ref_target:null"]);
    expect(issues[0]?.message).toContain("last");
    expect(issues[0]?.message).toContain("until");
  });

  it("is refused in any other node, and in a loop_until_dry body", () => {
    expect(
      summary(issuesOf([{ id: "a", type: "agent", prompt: "x ${last.draft}" }, loop()])),
    ).toEqual(["ref_target:null"]);
    const dry = {
      id: "dry",
      type: "loop_until_dry",
      body: last("last.draft"),
      stop_after_k_empty: 1,
      max_rounds: 2,
    };
    expect(summary(issuesOf([dry]))).toEqual(["ref_target:null"]);
  });

  it("is refused anywhere else in the loop's own fields, such as a schema inside the body", () => {
    const issues = loopIssues({ body: { prompt: "x", schema: { description: "${last.v}" } } });
    expect(summary(issues)).toEqual(["ref_target:null"]);
  });

  it("round and so_far are fine in the body prompt and in `until`", () => {
    const body = { prompt: "Round ${round}, earlier: ${so_far}" };
    expect(loopIssues({ body, until: { count_gte: { path: "${so_far}", n: 2 } } })).toEqual([]);
  });

  it("a node called `last` is still reachable from outside `until`", () => {
    const nodes = [
      { id: "last", type: "agent", prompt: "x" },
      loop({
        body: { prompt: "Fix ${last.draft}" },
        until: { field_true: { path: "${args.ok}" } },
      }),
    ];
    expect(issuesOf(nodes)).toEqual([]);
  });

  it("inside `until` it shadows a node called `last`, and the spec says so instead of guessing", () => {
    const issues = issuesOf([{ id: "last", type: "agent", prompt: "x" }, loop()]);
    expect(summary(issues)).toEqual(["ref_target:until"]);
    expect(issues[0]?.message).toContain("last");
    expect(issues[0]?.message).toContain("rename");
  });
});

describe("references and ordering (#980)", () => {
  it("a ref in `until` to an unknown node is a ref_target issue", () => {
    const issues = loopIssues({ until: { gte: { path: "${nope.score}", n: 1 } } });
    expect(summary(issues)).toEqual(["ref_target:null"]);
    expect(issues[0]?.message).toContain("nope");
  });

  it("a ref in the body prompt to an unknown node is a ref_target issue too", () => {
    expect(summary(loopIssues({ body: { prompt: "${nope.x}" } }))).toEqual(["ref_target:null"]);
  });

  it("the node `until` reads is a dependency: it runs first even when listed after the loop", () => {
    const result = validateSpec({
      meta: { name: "loop" },
      nodes: [
        loop({ until: { gte: { path: "${scan.threshold}", n: 1 } } }),
        { id: "scan", type: "agent", prompt: "scan" },
      ],
    });
    expect(result).toBeInstanceOf(WorkflowSpec);
    expect(topologicalOrder(result as WorkflowSpec).map((node) => node.id)).toEqual([
      "scan",
      "refine",
    ]);
  });
});
