#!/usr/bin/env node
/* global process */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  InvalidReferenceError,
  isValidationError,
  resolveValue,
  validateSpec,
} from "../../../dist/workflow/index.js";

const directory = resolve(".probe-evidence/workflow-spec");
mkdirSync(directory, { recursive: true });
let failed = 0;

function record(id, assertions) {
  const failures = assertions
    .filter((assertion) => !assertion.ok)
    .map((assertion) => assertion.name);
  const evidence = {
    id,
    class: "intentional-ts-only",
    assertions,
    failures,
    verdict: failures.length === 0 ? "match" : "divergent",
  };
  writeFileSync(resolve(directory, `${id}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (failures.length > 0) failed += 1;
}

const anyJson = [];
for (const type of [[], {}]) {
  let result;
  let thrown = false;
  try {
    result = validateSpec({ meta: { name: "x" }, nodes: [{ id: "a", type }] });
  } catch {
    thrown = true;
  }
  anyJson.push({ name: `no-throw-${Array.isArray(type) ? "array" : "object"}`, ok: !thrown });
  anyJson.push({
    name: `validation-${Array.isArray(type) ? "array" : "object"}`,
    ok:
      isValidationError(result) &&
      result.issues.some(
        (issue) =>
          issue.rule === "node_type" &&
          issue.nodeId === "a" &&
          issue.field === "type" &&
          issue.message.length > 0,
      ),
  });
}
record("t14-validate-any-json", anyJson);

const raw = {
  meta: { name: "x", tags: ["a"] },
  inputs: { x: { type: "string" } },
  schemas: { O: { type: "object" } },
  nodes: [{ id: "a", type: "agent", prompt: "x", depends_on: [] }],
};
const spec = validateSpec(raw);
const defensive = [];
if (isValidationError(spec)) {
  defensive.push({ name: "valid-spec", ok: false });
} else {
  raw.meta.tags.push("mutated");
  raw.nodes[0].depends_on.push("mutated");
  defensive.push({ name: "meta-copy", ok: spec.meta.tags.length === 1 });
  defensive.push({ name: "node-copy", ok: spec.nodes[0].fields.depends_on.length === 0 });
  defensive.push({
    name: "deep-freeze",
    ok: Object.isFrozen(spec.meta.tags) && Object.isFrozen(spec.nodes[0].fields.depends_on),
  });
}
record("t14-defensive-spec", defensive);

const invalid = [];
for (const reference of ["a.²", "a-b", "a b", "a+1", "", "lst.²"]) {
  let caught = null;
  try {
    resolveValue(`\${${reference}}`, { a: {}, lst: [1] });
  } catch (error) {
    caught = error;
  }
  invalid.push({
    name: reference || "empty",
    ok:
      caught instanceof InvalidReferenceError &&
      caught.code === "REF_INVALID" &&
      caught.reference === reference,
  });
}
record("t14-invalid-resolver-ref", invalid);

process.stdout.write(`${JSON.stringify({ probes: 3, failures: failed })}\n`);
process.exitCode = failed === 0 ? 0 : 1;
