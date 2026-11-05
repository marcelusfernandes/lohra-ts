// Issue #982 (S6 do épico #976, desenho §6): a validação do nó `call` — chamar
// `read_file` ou `web_fetch` sem modelo. O que prende:
//   - o registro: `call` é um tipo fechado, só `tool` é obrigatório, não tem
//     roteamento (não há modelo para rotear) nem `prompt`;
//   - `tool` tem de estar em `CALL_TOOLS` (a allow-list da porta, #978);
//   - `args` é um objeto com até `MAX_CALL_ARGS` (16) chaves, e os valores podem
//     ser `${ref}` — que passam pela varredura de refs de todo nó;
//   - `timeout` é um número positivo de até 120 s, `retries` um inteiro de 0 a 3
//     (as duas regras de knob que já valem em todo nó, sem mensagem duplicada).
import { describe, expect, it } from "vitest";

import { CALL_TOOLS, MAX_CALL_TIMEOUT_SECONDS } from "../src/workflow/call-tools.js";
import {
  DEFAULT_CALL_TIMEOUT_SECONDS,
  MAX_CALL_ARGS,
  MAX_NODE_RETRIES,
  NODE_SPECS,
  NODE_TYPES,
} from "../src/workflow/nodes.js";
import { NODE_VALIDATORS, validateCall } from "../src/workflow/schema-nodes.js";
import { validateSpec } from "../src/workflow/schema.js";
import { Node, type SpecIssue, ValidationError } from "../src/workflow/types.js";

const SCAN = { id: "scan", type: "agent", prompt: "Find the url in ${args.text}" };

const call = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "fetch",
  type: "call",
  tool: "web_fetch",
  args: { url: "${args.url}" },
  ...fields,
});

function issuesOf(nodes: readonly Record<string, unknown>[]): readonly SpecIssue[] {
  const result = validateSpec({ meta: { name: "call" }, nodes });
  return result instanceof ValidationError ? result.issues : [];
}

const callIssues = (fields: Record<string, unknown> = {}): readonly SpecIssue[] =>
  issuesOf([SCAN, call(fields)]);

const shape = (issues: readonly SpecIssue[]): string[] =>
  issues.map((issue) => `${issue.rule}:${String(issue.field)}`);

const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(call()).filter(([key]) => key !== field));

describe("call is a registered node type (#982)", () => {
  it("is one of the closed node types, with only 'tool' required and no routing", () => {
    expect(NODE_TYPES.has("call")).toBe(true);
    const nodeSpec = NODE_SPECS.call;
    expect([...(nodeSpec?.required ?? [])]).toEqual(["tool"]);
    for (const field of ["tool", "args", "timeout", "retries", "required", "depends_on"])
      expect(nodeSpec?.fields).toContain(field);
    for (const field of ["model", "tier", "effort", "provider", "prompt", "schema", "default"])
      expect(nodeSpec?.fields).not.toContain(field);
  });

  it("fixes the limits the validation and the skill quote", () => {
    expect(MAX_CALL_ARGS).toBe(16);
    expect(MAX_CALL_TIMEOUT_SECONDS).toBe(120);
    expect(MAX_NODE_RETRIES).toBe(3);
    expect(DEFAULT_CALL_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_CALL_TIMEOUT_SECONDS).toBeLessThanOrEqual(MAX_CALL_TIMEOUT_SECONDS);
  });

  it("registers its validator by type", () => {
    expect(NODE_VALIDATORS.get("call")).toBe(validateCall);
  });

  it("validateCall ignores every other node type", () => {
    const issues: SpecIssue[] = [];
    validateCall(new Node("a", "agent", { prompt: "x" }), issues);
    expect(issues).toEqual([]);
  });
});

describe("the validation of a call (#982)", () => {
  it("accepts the whole node, and a node with 'tool' alone", () => {
    expect(callIssues()).toEqual([]);
    expect(issuesOf([{ id: "read", type: "call", tool: "read_file" }])).toEqual([]);
  });

  it("accepts every tool the port's allow-list has", () => {
    for (const tool of CALL_TOOLS) expect(callIssues({ tool })).toEqual([]);
  });

  it("a node without 'tool' is a missing_field, and only that", () => {
    expect(shape(issuesOf([SCAN, without("tool")]))).toEqual(["missing_field:tool"]);
  });

  it("a node can be depended on, depend on others, and be read by a later node", () => {
    const issues = issuesOf([
      SCAN,
      call({ depends_on: ["scan"], args: { url: "${scan.url}" } }),
      { id: "use", type: "agent", prompt: "Summarise ${fetch.text}" },
    ]);
    expect(issues).toEqual([]);
  });

  describe("tool", () => {
    it.each([
      ["a tool with a side effect", "write_file"],
      ["the shell", "terminal"],
      ["a tool the policy does not limit", "web_search"],
      ["an mcp tool", "mcp_files_read"],
      ["another case", "Read_File"],
      ["an empty string", ""],
      ["a ref", "${args.tool}"],
      ["a number", 3],
      ["null", null],
      ["a list", ["read_file"]],
    ])("refuses %s", (_label, tool) => {
      expect(shape(callIssues({ tool }))).toEqual(["field_value:tool"]);
    });

    it("names the tools it accepts", () => {
      const issue = callIssues({ tool: "terminal" })[0];
      for (const tool of CALL_TOOLS) expect(issue?.message).toContain(tool);
      expect(issue?.example).toContain("tool:");
    });
  });

  describe("args", () => {
    it("is optional, and an empty object is fine", () => {
      expect(issuesOf([SCAN, without("args")])).toEqual([]);
      expect(callIssues({ args: {} })).toEqual([]);
    });

    it.each([
      ["a list", ["https://example.test"]],
      ["a string", "https://example.test"],
      ["a number", 3],
      ["null", null],
    ])("refuses %s", (_label, args) => {
      expect(shape(callIssues({ args }))).toEqual(["field_value:args"]);
    });

    it("takes up to 16 keys and refuses the 17th", () => {
      const keys = (count: number): Record<string, string> =>
        Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${String(index)}`, "v"]));
      expect(callIssues({ args: keys(MAX_CALL_ARGS) })).toEqual([]);
      const refused = callIssues({ args: keys(MAX_CALL_ARGS + 1) });
      expect(shape(refused)).toEqual(["field_value:args"]);
      expect(refused[0]?.message).toContain(String(MAX_CALL_ARGS));
    });

    it("lets a value be a literal, a ${ref} or a structure with refs in it", () => {
      expect(
        callIssues({
          args: { a: 1, b: true, c: "x", d: "${scan.url}", e: { f: ["${args.url}"] } },
        }),
      ).toEqual([]);
    });

    it("a ref to a node that does not exist is a ref_target issue", () => {
      expect(shape(callIssues({ args: { url: "${ghost.url}" } }))).toEqual(["ref_target:null"]);
    });

    it("a ref that is an expression is a ref_expression issue", () => {
      expect(shape(callIssues({ args: { url: "${scan.a + scan.b}" } }))).toEqual([
        "ref_expression:null",
      ]);
    });
  });

  describe("timeout", () => {
    it.each([1, 30, 119.5, MAX_CALL_TIMEOUT_SECONDS])("accepts %s seconds", (timeout) => {
      expect(callIssues({ timeout })).toEqual([]);
    });

    it.each([MAX_CALL_TIMEOUT_SECONDS + 0.5, 121, 600, 1e9])(
      "refuses %s: past the 120 s ceiling",
      (timeout) => {
        const issues = callIssues({ timeout });
        expect(shape(issues)).toEqual(["field_value:timeout"]);
        expect(issues[0]?.message).toContain("120");
      },
    );

    it.each([0, -1, "5", null, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses %s once, with the rule every node has",
      (timeout) => {
        expect(shape(callIssues({ timeout }))).toEqual(["field_value:timeout"]);
      },
    );
  });

  describe("retries", () => {
    it.each([0, 1, 2, MAX_NODE_RETRIES])("accepts %s", (retries) => {
      expect(callIssues({ retries })).toEqual([]);
    });

    it.each([MAX_NODE_RETRIES + 1, -1, 1.5, "2", null])("refuses %s", (retries) => {
      expect(shape(callIssues({ retries }))).toEqual(["field_value:retries"]);
    });
  });

  describe("routing", () => {
    it.each(["model", "tier", "effort", "provider"])(
      "refuses '%s': a call has no model to route",
      (knob) => {
        const issues = callIssues({ [knob]: "x" });
        expect(shape(issues)).toEqual([`unknown_field:${knob}`]);
      },
    );

    it("refuses a prompt and a schema, which belong to a leaf", () => {
      expect(shape(callIssues({ prompt: "x", schema: { type: "object" } })).sort()).toEqual([
        "unknown_field:prompt",
        "unknown_field:schema",
      ]);
    });
  });
});
