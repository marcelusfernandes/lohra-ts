import { describe, expect, it } from "vitest";

import {
  UNPARSEABLE,
  Node,
  WorkflowSpec,
  dependencies,
  loadsLenient,
  parseWorkflowPolicy,
  refRoots,
  topologicalOrder,
  validateSpec,
} from "../src/workflow/index.js";

const cycleSpec = {
  meta: { name: "cycle" },
  nodes: [
    { id: "a", type: "agent", prompt: "${b.x} ${c.x}" },
    { id: "b", type: "agent", prompt: "${a.x}" },
    { id: "c", type: "agent", prompt: "${a.x}" },
  ],
};

describe("workflow dependency graph", () => {
  it("derives roots from values and preserves declaration order for ties", () => {
    const spec = validateSpec({
      meta: { name: "order" },
      nodes: [
        { id: "b", type: "agent", prompt: "independent" },
        { id: "a", type: "agent", prompt: "independent" },
        { id: "c", type: "agent", prompt: "${a.output}", depends_on: ["b"] },
      ],
    });
    if ("issues" in spec) throw new Error("unexpected validation error");

    expect(refRoots({ "${ignored.key}": "${a.value}", nested: ["${b.value}"] })).toEqual(
      new Set(["a", "b"]),
    );
    const ids = new Set(spec.nodes.map((node) => node.id));
    expect(spec.nodes.map((node) => [node.id, dependencies(node, ids)])).toEqual([
      ["b", new Set()],
      ["a", new Set()],
      ["c", new Set(["b", "a"])],
    ]);
    expect(topologicalOrder(spec).map((node) => node.id)).toEqual(["b", "a", "c"]);
  });

  it("exposes the canonical cycle graph independently of traversal wording", () => {
    const result = validateSpec(cycleSpec);
    expect("issues" in result).toBe(true);
    const graphInput = new WorkflowSpec({
      meta: { name: "graph" },
      inputs: {},
      schemas: {},
      nodes: cycleSpec.nodes.map((node) => new Node(node.id, node.type, { prompt: node.prompt })),
    });
    expect(
      graphInput.nodes
        .flatMap((node) =>
          [...dependencies(node, new Set(["a", "b", "c"]))].map((dep) => `${node.id}->${dep}`),
        )
        .sort(),
    ).toEqual(["a->b", "a->c", "b->a", "c->a"]);
  });
});

describe("lenient workflow JSON", () => {
  it("accepts raw, fenced, balanced and Python special floats", () => {
    const fence = String.fromCharCode(96).repeat(3);
    expect(loadsLenient('{"a": 1}')).toEqual({ a: 1 });
    expect(loadsLenient(`${fence}json\n{"a": 1}\n${fence}`)).toEqual({ a: 1 });
    expect(loadsLenient('prefix {"a": 1} suffix')).toEqual({ a: 1 });
    expect(loadsLenient("NaN")).toBeNaN();
    expect(loadsLenient("Infinity")).toBe(Infinity);
    expect(loadsLenient("-Infinity")).toBe(-Infinity);
    expect(loadsLenient("not-json")).toBe(UNPARSEABLE);
  });
});

describe("pure workflow policy normalization", () => {
  it("normalizes roots and egress without filesystem or runtime imports", () => {
    expect(
      parseWorkflowPolicy(
        JSON.stringify({
          fs_allow: ["/a", { path: "/b", mode: "ro" }, { path: "/c", mode: "bad" }, {}],
          egress_allow: ["api.example.test", 4, ""],
        }),
      ),
    ).toEqual({
      fsAllow: [
        { path: "/a", writable: true },
        { path: "/b", writable: false },
      ],
      egressAllow: ["api.example.test", ""],
    });
    expect(parseWorkflowPolicy("malformed")).toEqual({ fsAllow: [], egressAllow: [] });
  });
});
