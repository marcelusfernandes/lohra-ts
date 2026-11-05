// Issue #979 (S2 do épico #976): a validação do nó `switch` — `value` (um
// `${ref}`), `cases` (2 a 16 chaves, cada uma `null` ou agent-shaped com
// `prompt`) e `otherwise` (nomeia um caso). O corpo de cada caso passa pelas
// mesmas regras de nome e de valor dos demais sub-objetos agent-shaped
// (`schemaBearingSubObjects`, `schema.ts`), e um knob de roteamento só vale no
// nó, nunca dentro de um caso.
import { describe, expect, it } from "vitest";

import { MAX_SWITCH_CASES, NODE_SPECS, NODE_TYPES } from "../src/workflow/nodes.js";
import { topologicalOrder } from "../src/workflow/graph.js";
import { NODE_VALIDATORS, validateSwitch } from "../src/workflow/schema-nodes.js";
import { validateSpec } from "../src/workflow/schema.js";
import { Node, type SpecIssue, ValidationError, WorkflowSpec } from "../src/workflow/types.js";

const CASES = { reuse: null, investigate: { prompt: "Dig into ${args.text}" } };

const sw = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "route",
  type: "switch",
  value: "${args.kind}",
  cases: CASES,
  ...fields,
});

function issuesOf(nodes: readonly Record<string, unknown>[], extra = {}): readonly SpecIssue[] {
  const result = validateSpec({ meta: { name: "switch" }, nodes, ...extra });
  return result instanceof ValidationError ? result.issues : [];
}

const switchIssues = (fields: Record<string, unknown> = {}): readonly SpecIssue[] =>
  issuesOf([sw(fields)]);

const fieldsOf = (issues: readonly SpecIssue[]): (string | null)[] =>
  issues.map((issue) => issue.field);

const manyCases = (count: number): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`c${String(index)}`, null]));

describe("switch is a registered node type (#979)", () => {
  it("is one of the closed node types, with routing at the node and value + cases required", () => {
    expect(NODE_TYPES.has("switch")).toBe(true);
    const spec = NODE_SPECS.switch;
    expect([...(spec?.required ?? [])].sort()).toEqual(["cases", "value"]);
    for (const field of ["value", "cases", "otherwise", "model", "tier", "effort", "provider"])
      expect(spec?.fields).toContain(field);
    // The lifecycle knobs live in each case body; the node itself has none.
    for (const field of ["prompt", "timeout", "retries", "max_iterations", "tool_less", "schema"])
      expect(spec?.fields).not.toContain(field);
  });

  it("caps the cases at 16 and registers its validator by type", () => {
    expect(MAX_SWITCH_CASES).toBe(16);
    expect(NODE_VALIDATORS.get("switch")).toBe(validateSwitch);
  });

  it("validateSwitch ignores every other node type", () => {
    const issues: SpecIssue[] = [];
    validateSwitch(new Node("a", "agent", { prompt: "x", value: 3, cases: 1 }), issues);
    expect(issues).toEqual([]);
  });
});

describe("a well formed switch validates (#979)", () => {
  it("accepts a null case, an agent-shaped case and an otherwise that names one", () => {
    const result = validateSpec({
      meta: { name: "switch" },
      nodes: [sw({ otherwise: "investigate" })],
    });
    expect(result).toBeInstanceOf(WorkflowSpec);
  });

  it("accepts node-level routing knobs, and case bodies with their own lifecycle knobs", () => {
    const issues = switchIssues({
      tier: "big",
      provider: "p",
      cases: {
        reuse: null,
        investigate: { prompt: "x", retries: 1, timeout: 30, max_iterations: 4, tool_less: true },
      },
    });
    expect(issues).toEqual([]);
  });

  it("accepts the boundaries: exactly 2 and exactly MAX_SWITCH_CASES cases", () => {
    expect(switchIssues({ cases: manyCases(2) })).toEqual([]);
    expect(switchIssues({ cases: manyCases(MAX_SWITCH_CASES) })).toEqual([]);
  });

  it("accepts a case body with a schema or a named schema_ref", () => {
    const result = validateSpec({
      meta: { name: "switch" },
      schemas: { VERDICT: { type: "object" } },
      nodes: [
        sw({
          cases: {
            a: { prompt: "x", schema: { type: "string" } },
            b: { prompt: "y", schema_ref: "VERDICT" },
          },
        }),
      ],
    });
    expect(result).toBeInstanceOf(WorkflowSpec);
  });
});

describe("value must be exactly one ${ref} (#979)", () => {
  it("is required", () => {
    const raw = sw();
    delete raw.value;
    const issues = issuesOf([raw]);
    expect(issues.map((issue) => `${issue.rule}:${String(issue.field)}`)).toEqual([
      "missing_field:value",
    ]);
  });

  it.each([
    ["plain text", "verdict"],
    ["text around the ref", "kind is ${args.kind}"],
    ["two refs", "${args.a}${args.b}"],
    ["no ref braces", "$args.kind"],
    ["a number", 3],
    ["an object", { path: "${args.kind}" }],
    ["null", null],
    ["an empty string", ""],
  ])("refuses %s, naming the field and an example", (_label, value) => {
    const issues = switchIssues({ value });
    const mine = issues.filter((issue) => issue.field === "value");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rule: "field_value", nodeId: "route" });
    expect(mine[0]?.message).toContain("${ref}");
    expect(mine[0]?.example).toContain("${");
  });

  it("an expression is a ref_expression, never a valid path", () => {
    const issues = switchIssues({ value: "${a+b}" });
    expect(issues.map((issue) => issue.rule)).toContain("ref_expression");
    expect(fieldsOf(issues)).toContain("value");
  });

  it("a ref to an unknown node is a ref_target issue", () => {
    const issues = switchIssues({ value: "${nope.kind}" });
    expect(issues.map((issue) => issue.rule)).toEqual(["ref_target"]);
  });

  it("a ref to a node and a deep path are both fine", () => {
    const issues = issuesOf([
      { id: "scan", type: "agent", prompt: "x" },
      sw({ value: "${scan.result.verdict.0}" }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe("cases is a mapping of 2 to 16 names (#979)", () => {
  it("is required", () => {
    const raw = sw();
    delete raw.cases;
    expect(issuesOf([raw]).map((issue) => `${issue.rule}:${String(issue.field)}`)).toEqual([
      "missing_field:cases",
    ]);
  });

  it.each([
    ["a list", [null, null]],
    ["a string", "reuse"],
    ["a number", 2],
    ["null", null],
    ["an empty mapping", {}],
    ["a single case", { only: null }],
    ["one over the cap", manyCases(MAX_SWITCH_CASES + 1)],
  ])("refuses %s", (_label, cases) => {
    const issues = switchIssues({ cases });
    const mine = issues.filter((issue) => issue.field === "cases");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rule: "field_value", nodeId: "route" });
    expect(mine[0]?.message).toMatch(/2 to 16/u);
    expect(mine[0]?.example).not.toBeNull();
  });
});

describe("each case is null or an agent-shaped object with a prompt (#979)", () => {
  it.each([
    ["a string", "just run it"],
    ["a number", 1],
    ["a list", ["x"]],
    ["an object with no prompt", {}],
    ["an object whose prompt is blank", { prompt: "   " }],
    ["an object whose prompt is empty", { prompt: "" }],
    ["an object whose prompt is null", { prompt: null }],
  ])("refuses %s, at the case's own field", (_label, body) => {
    const issues = switchIssues({ cases: { reuse: null, investigate: body } });
    expect(fieldsOf(issues)).toEqual(["cases.investigate"]);
    expect(issues[0]).toMatchObject({ rule: "field_value", nodeId: "route" });
    expect(issues[0]?.message).toContain("prompt");
    expect(issues[0]?.example).toContain("prompt");
  });

  it("names every bad case, one issue each", () => {
    const issues = switchIssues({ cases: { a: "x", b: null, c: {} } });
    expect(fieldsOf(issues)).toEqual(["cases.a", "cases.c"]);
  });

  it("an unknown field in a case body is refused like in any agent-shaped sub-object", () => {
    const issues = switchIssues({ cases: { a: null, b: { prompt: "x", bogus: 1 } } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "unknown_field", field: "cases.b.bogus" });
  });

  it.each(["model", "tier", "effort", "provider"])(
    "a routing knob (%s) inside a case is refused: routing goes on the node",
    (knob) => {
      const issues = switchIssues({ cases: { a: null, b: { prompt: "x", [knob]: "big" } } });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ rule: "unknown_field", field: `cases.b.${knob}` });
      expect(issues[0]?.message).toContain("routing knobs go on the node");
    },
  );

  it("a routing knob on the node itself is validated like anywhere: a bad tier is refused", () => {
    expect(fieldsOf(switchIssues({ tier: "huge" }))).toEqual(["tier"]);
  });

  it.each([
    ["retries", 9, "cases.b.retries"],
    ["timeout", -1, "cases.b.timeout"],
    ["max_iterations", 0, "cases.b.max_iterations"],
    ["tool_less", "yes", "cases.b.tool_less"],
  ])("the case's %s knob is value-checked", (knob, value, field) => {
    const issues = switchIssues({ cases: { a: null, b: { prompt: "x", [knob]: value } } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "field_value", field });
  });

  it("a case with both schema and schema_ref, or a schema_ref with no entry, is refused", () => {
    const both = switchIssues({
      cases: { a: null, b: { prompt: "x", schema: { type: "string" }, schema_ref: "S" } },
    });
    expect(both.map((issue) => issue.rule)).toContain("schema_xor");
    const missing = switchIssues({ cases: { a: null, b: { prompt: "x", schema_ref: "NOPE" } } });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ rule: "schema_ref", field: "cases.b.schema_ref" });
  });
});

describe("otherwise must name a case (#979)", () => {
  it("is optional", () => {
    expect(switchIssues()).toEqual([]);
  });

  it.each([
    ["a name that is not a case", "missing"],
    ["a number", 1],
    ["null", null],
    ["a list", ["reuse"]],
    ["an inherited name", "constructor"],
  ])("refuses %s", (_label, otherwise) => {
    const issues = switchIssues({ otherwise });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "field_value", field: "otherwise", nodeId: "route" });
    expect(issues[0]?.message).toContain("cases");
    expect(issues[0]?.example).toContain("otherwise");
  });

  it("naming the null case is fine", () => {
    expect(switchIssues({ otherwise: "reuse" })).toEqual([]);
  });
});

describe("the rest of the node is closed (#979)", () => {
  it("refuses a field the switch does not have, listing the ones it has", () => {
    const issues = switchIssues({ branches: ["x"], timeout: 5 });
    expect(issues.map((issue) => issue.rule)).toEqual(["unknown_field", "unknown_field"]);
    expect(issues[0]?.message).toBe("'switch' has no field 'branches'");
    expect(issues[0]?.example).toContain("'cases'");
    expect(issues[0]?.example).toContain("'otherwise'");
  });

  it("references inside a case prompt must point at a real node", () => {
    const issues = switchIssues({ cases: { a: null, b: { prompt: "see ${ghost.out}" } } });
    expect(issues.map((issue) => issue.rule)).toEqual(["ref_target"]);
  });

  it("a switch whose value reads its own output is a dependency cycle", () => {
    const issues = switchIssues({ value: "${route.case}" });
    expect(issues.map((issue) => issue.rule)).toContain("cycle");
  });
});

describe("the graph runs the switch after everything it reads (#979)", () => {
  it("orders the value's node and the nodes a case prompt reads before the switch", () => {
    const result = validateSpec({
      meta: { name: "switch" },
      nodes: [
        sw({
          value: "${scan.kind}",
          cases: { a: null, b: { prompt: "use ${notes.text}" } },
        }),
        { id: "notes", type: "agent", prompt: "n" },
        { id: "scan", type: "agent", prompt: "s" },
      ],
    });
    expect(result).toBeInstanceOf(WorkflowSpec);
    const ordered = topologicalOrder(result as WorkflowSpec).map((node) => node.id);
    expect(ordered.indexOf("route")).toBe(2);
    expect(ordered.slice(0, 2).sort()).toEqual(["notes", "scan"]);
  });
});
