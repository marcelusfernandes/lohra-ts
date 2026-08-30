#!/usr/bin/env node
/* global process */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { pythonFloat, pythonJsonDumps } from "../../../dist/serialization/python-json.js";
import {
  MAX_GATE_ATTEMPTS,
  MAX_NODE_MAX_ITERATIONS,
  MAX_NODE_RETRIES,
  MAX_STATIC_FANOUT,
  NODE_SPECS,
  NODE_TYPES,
  Node,
  UNPARSEABLE,
  dependencies,
  findRefs,
  invalidRefs,
  isValidRef,
  isValidationError,
  loadsLenient,
  normalizeWorkflowPolicy,
  refRoots,
  resolveStrict,
  resolveValue,
  topologicalOrder,
  validateSpec,
} from "../../../dist/workflow/index.js";

const [scenario, fixturePath, mutant = ""] = process.argv.slice(2);
if (!scenario || !fixturePath) throw new Error("usage: candidate-driver <scenario> <fixture>");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

function issueProjection(error, raw) {
  if (scenario === "validation-cycle-canonical") {
    writeFileSync(
      resolve(process.env.HOME, "cycle-raw.json"),
      `${JSON.stringify({ message: error.message })}\n`,
    );
    const nodes = raw.nodes.map(
      (item) =>
        new Node(
          item.id,
          item.type,
          Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== "id" && key !== "type"),
          ),
        ),
    );
    const ids = new Set(nodes.map((node) => node.id));
    const edges = nodes
      .flatMap((node) => [...dependencies(node, ids)].map((dep) => `${node.id}->${dep}`))
      .sort();
    return {
      kind: "validation_error",
      issues: [{ rule: "cycle", node_id: "a", cycle_nodes: [...ids].sort(), cycle_edges: edges }],
    };
  }
  const tuples = error.issues.map((entry) => [
    entry.rule,
    entry.nodeId ?? "",
    entry.field ?? "",
    entry.message,
    entry.example ?? "",
  ]);
  if (tuples.length > 1)
    tuples.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    kind: "validation_error",
    issues: tuples,
    message: tuples.length === 1 ? error.message : null,
  };
}

function specProjection(spec) {
  return {
    kind: "workflow_spec",
    meta: spec.meta,
    inputs: spec.inputs,
    schemas: spec.schemas,
    nodes: spec.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      fields: node.fields,
      required: node.required,
    })),
  };
}

function validation(raw, supported) {
  const result = validateSpec(raw, supported ? { supportedTypes: new Set(supported) } : {});
  return isValidationError(result) ? issueProjection(result, raw) : specProjection(result);
}

function validationFixture(name) {
  const value = fixtures[name];
  if (Array.isArray(value)) return value.map((item) => validation(item));
  if (value?.raw) return validation(value.raw, value.supported);
  return validation(value);
}

function registry() {
  return {
    types: [...NODE_TYPES].sort(),
    specs: Object.fromEntries(
      Object.entries(NODE_SPECS).map(([name, spec]) => [
        name,
        { required: [...spec.required].sort(), fields: [...spec.fields].sort() },
      ]),
    ),
    constants: { MAX_STATIC_FANOUT, MAX_NODE_RETRIES, MAX_GATE_ATTEMPTS, MAX_NODE_MAX_ITERATIONS },
  };
}

function refsGrammar() {
  const arabicValid = mutant === "ascii-ref" ? false : isValidRef("a.٣");
  return {
    arabicValid,
    superscriptValid: isValidRef("a.²"),
    found: findRefs("x=${a.٣}; y=${a.²}"),
    invalid: invalidRefs("x=${a.٣}; y=${a.²}"),
  };
}

function refsResolve() {
  const context = fixtures.refs.context;
  return {
    whole: resolveValue("  ${a.b}  ", context),
    index: resolveValue("${lst.١}", context),
    missing: resolveValue("${lst.٣}", context),
    injectedWhole: resolveValue("${inj}", context),
    injectedEmbedded: resolveValue("x=${inj}", context),
    nested: resolveValue({ "${a.b}": ["${a.b}"] }, context),
  };
}

function refsNumeric() {
  if (mutant === "js-stringify") return { float: "v=1", big: "v=12345678901234567000" };
  return {
    float: resolveValue("v=${num}", { num: pythonFloat(1) }),
    big: resolveValue("v=${big}", { big: 12345678901234567890n }),
  };
}

function graphResult() {
  const spec = validateSpec(fixtures.graph);
  if (isValidationError(spec)) throw new Error(spec.message);
  const ids = new Set(spec.nodes.map((node) => node.id));
  const deps = Object.fromEntries(
    spec.nodes.map((node) => [node.id, [...dependencies(node, ids)].sort()]),
  );
  let topo = topologicalOrder(spec).map((node) => node.id);
  if (mutant === "topo-id-sort") topo = [...topo].sort();
  return {
    roots: [...refRoots({ key: "${a.x}", nested: ["${b.x}", "${bad+1}"] })].sort(),
    dependencies: deps,
    topological: topo,
  };
}

function jsonio() {
  const fence = "```";
  return [
    '{"a":1}',
    `${fence}json\n[1,2]\n${fence}`,
    'before {"x":2} after',
    "NaN",
    "Infinity",
    "-Infinity",
    "bad",
  ].map((text) => {
    const value = loadsLenient(text);
    if (value === UNPARSEABLE) return { kind: "unparseable" };
    if (typeof value === "number" && Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return value;
  });
}

const validationMap = {
  "valid-minimal": "validMinimal",
  "valid-doc-fixture": "doc",
  "valid-all-node-types": "validAll",
  "validation-top-level": "topLevel",
  "validation-meta": "meta",
  "validation-schemas": "schemas",
  "validation-node-shape": "nodeShape",
  "validation-supported": "supported",
  "validation-fields": "fields",
  "validation-schema": "schema",
  "validation-refs": "refsValidation",
  "validation-lifecycle": "lifecycle",
  "validation-tier": "tier",
  "validation-gate": "gate",
  "validation-fanout": "fanout",
  "validation-duplicates": "duplicates",
  "validation-cascade": "cascade",
  "validation-multi-canonical": "multi",
  "validation-cycle-canonical": "cycle",
  "normalization-quirks": "quirks",
};

let outcome;
if (scenario === "registry-shape") outcome = registry();
else if (validationMap[scenario]) outcome = validationFixture(validationMap[scenario]);
else if (scenario === "refs-grammar" || scenario === "mutant-ascii-ref") outcome = refsGrammar();
else if (scenario === "refs-resolve") outcome = refsResolve();
else if (scenario === "refs-numeric" || scenario === "mutant-js-stringify") outcome = refsNumeric();
else if (scenario === "refs-strict")
  outcome = {
    missing: resolveStrict("x=${a.none}; y=${b.none}", { a: {}, b: {} }),
    ok: resolveStrict("x=${a.value}", { a: { value: "ok" } }),
  };
else if (
  scenario === "graph-dependencies" ||
  scenario === "graph-topological" ||
  scenario === "mutant-topo-id-sort"
)
  outcome = graphResult();
else if (scenario === "jsonio-lenient") outcome = jsonio();
else if (scenario === "policy-normalization") outcome = normalizeWorkflowPolicy(fixtures.policy);
else throw new Error(`unknown scenario ${scenario}`);

process.stdout.write(
  `${pythonJsonDumps({ operation: scenario, cases: [{ id: scenario, outcome }] })}\n`,
);
