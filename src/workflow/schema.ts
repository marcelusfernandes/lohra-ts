import {
  MAX_GATE_ATTEMPTS,
  MAX_NODE_MAX_ITERATIONS,
  MAX_NODE_RETRIES,
  MAX_STATIC_FANOUT,
  NODE_SPECS,
  NODE_TYPES,
} from "./nodes.js";
import { findRefs, invalidRefs, isValidRef } from "./refs.js";
import { Node, SpecIssue, ValidationError, WorkflowSpec } from "./types.js";

export interface ValidateSpecOptions {
  readonly supportedTypes?: ReadonlySet<string>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const pythonRepr = (value: unknown): string => {
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (record(value) !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${pythonRepr(k)}: ${pythonRepr(v)}`)
      .join(", ")}}`;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (value === undefined) return "None";
  return "<unknown>";
};

const allowedExample = (fields: readonly string[]): string =>
  `allowed: [${[...fields]
    .sort()
    .map((field) => `'${field}'`)
    .join(", ")}]`;

function issue(
  issues: SpecIssue[],
  rule: string,
  message: string,
  nodeId: string | null = null,
  field: string | null = null,
  example: string | null = null,
): void {
  issues.push(new SpecIssue({ rule, message, nodeId, field, example }));
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function refsIn(value: unknown): readonly string[] {
  return findRefs(value);
}

function detectCycle(nodes: readonly Node[]): readonly string[] | null {
  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    const deps: string[] = [];
    for (const reference of refsIn(node.fields)) {
      const root = reference.split(".", 1)[0];
      if (root !== undefined && !deps.includes(root)) deps.push(root);
    }
    for (const dependency of stringArray(node.fields.depends_on)) {
      if (!deps.includes(dependency)) deps.push(dependency);
    }
    graph.set(node.id, deps);
  }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): readonly string[] | null => {
    if (active.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (done.has(id)) return null;
    active.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!graph.has(dependency)) continue;
      const found = visit(dependency, [...path, id]);
      if (found !== null) return found;
    }
    active.delete(id);
    done.add(id);
    return null;
  };
  for (const node of nodes) {
    const found = visit(node.id, []);
    if (found !== null) return found;
  }
  return null;
}

function validateShape(
  raw: Record<string, unknown>,
  index: number,
  issues: SpecIssue[],
  supported: ReadonlySet<string> | undefined,
): { node: Node | null; duplicateCandidate: string | null } {
  const id = raw.id;
  if (typeof id !== "string" || id === "") {
    issue(
      issues,
      "node_id",
      `node #${String(index)} needs a string 'id'`,
      null,
      `nodes[${String(index)}].id`,
      "- id: scan",
    );
    return { node: null, duplicateCandidate: null };
  }
  const nodeType = raw.type;
  if (typeof nodeType !== "string" || !NODE_TYPES.has(nodeType)) {
    issue(
      issues,
      "node_type",
      `unknown node type ${pythonRepr(nodeType)}`,
      id,
      "type",
      `type: one of [${[...NODE_TYPES]
        .sort()
        .map((name) => `'${name}'`)
        .join(", ")}]`,
    );
    return { node: null, duplicateCandidate: null };
  }
  if (supported !== undefined && !supported.has(nodeType)) {
    issue(
      issues,
      "unsupported_type",
      `node type '${nodeType}' is valid but not executable yet`,
      id,
      "type",
      `supported now: [${[...supported]
        .sort()
        .map((name) => `'${name}'`)
        .join(", ")}]`,
    );
    return { node: null, duplicateCandidate: null };
  }
  const nodeSpec = NODE_SPECS[nodeType];
  if (nodeSpec === undefined) return { node: null, duplicateCandidate: id };
  const allowed = new Set(["id", "type", ...nodeSpec.fields]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issue(
        issues,
        "unknown_field",
        `'${nodeType}' has no field '${key}'`,
        id,
        key,
        allowedExample(nodeSpec.fields),
      );
    }
  }
  for (const required of nodeSpec.required) {
    if (!(required in raw)) {
      issue(issues, "missing_field", `'${nodeType}' requires '${required}'`, id, required);
    }
  }
  if (nodeType === "agent" && "schema" in raw && "schema_ref" in raw) {
    issue(issues, "schema_xor", "use either 'schema' or 'schema_ref', not both", id, "schema_ref");
  }
  const fields = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== "id" && key !== "type"),
  );
  return { node: new Node(id, nodeType, fields), duplicateCandidate: id };
}

function validateLifecycle(node: Node, issues: SpecIssue[]): void {
  const timeout = node.fields.timeout;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    issue(
      issues,
      "field_value",
      "'timeout' must be a positive number of seconds",
      node.id,
      "timeout",
      "timeout: 120",
    );
  }
  const retries = node.fields.retries;
  if (
    retries !== undefined &&
    (!Number.isInteger(retries) ||
      typeof retries !== "number" ||
      retries < 0 ||
      retries > MAX_NODE_RETRIES)
  ) {
    issue(
      issues,
      "field_value",
      "'retries' must be a whole number between 0 and 3",
      node.id,
      "retries",
      "retries: 1",
    );
  }
  const iterations = node.fields.max_iterations;
  if (
    iterations !== undefined &&
    (!Number.isInteger(iterations) ||
      typeof iterations !== "number" ||
      iterations < 1 ||
      iterations > MAX_NODE_MAX_ITERATIONS)
  ) {
    issue(
      issues,
      "field_value",
      "'max_iterations' must be a whole number between 1 and 128",
      node.id,
      "max_iterations",
      "max_iterations: 24",
    );
  }
  if (node.type === "pipeline" && Array.isArray(node.fields.stages)) {
    node.fields.stages.forEach((stage, index) => {
      const stageRecord = record(stage);
      if (stageRecord === null || !("max_iterations" in stageRecord)) return;
      const value = stageRecord.max_iterations;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        typeof value === "boolean" ||
        value < 1 ||
        value > MAX_NODE_MAX_ITERATIONS
      ) {
        issue(
          issues,
          "field_value",
          "'max_iterations' must be a whole number between 1 and 128",
          node.id,
          `stages[${String(index)}].max_iterations`,
          "max_iterations: 24",
        );
      }
    });
  }
}

function validateTier(node: Node, issues: SpecIssue[]): void {
  const tier = node.fields.tier;
  if (
    tier !== undefined &&
    (typeof tier !== "string" || !["small", "medium", "big"].includes(tier))
  ) {
    issue(
      issues,
      "field_value",
      "'tier' must be one of ['small', 'medium', 'big'] (the operator maps each one to a real model in ~/.lohra/workflow_tiers.json)",
      node.id,
      "tier",
      "tier: big",
    );
  }
}

function validateGate(node: Node, issues: SpecIssue[]): void {
  if (node.type !== "gate") return;
  const body = record(node.fields.body);
  const prompt = body?.prompt;
  const promptPresent =
    typeof prompt === "string"
      ? prompt.trim() !== ""
      : prompt !== undefined && prompt !== null && prompt !== false && prompt !== 0;
  if (body === null || !("prompt" in body) || !promptPresent) {
    issue(
      issues,
      "field_value",
      "'body' must be an agent-shaped object with a 'prompt' (add 'schema'/'schema_ref' to get validated JSON back)",
      node.id,
      "body",
      'body: {prompt: "Draft the migration plan"}',
    );
  }
  if (typeof node.fields.validator !== "string" || node.fields.validator.trim() === "") {
    issue(
      issues,
      "field_value",
      "'validator' must be the prompt a reviewer leaf answers {ok, feedback} to (the candidate is appended for you)",
      node.id,
      "validator",
      'validator: "Does the plan name every affected file?"',
    );
  }
  const attempts = node.fields.attempts;
  if (
    attempts !== undefined &&
    (!Number.isInteger(attempts) ||
      typeof attempts !== "number" ||
      attempts < 1 ||
      attempts > MAX_GATE_ATTEMPTS)
  ) {
    issue(
      issues,
      "field_value",
      "'attempts' must be a whole number between 1 and 3",
      node.id,
      "attempts",
      "attempts: 2",
    );
  }
}

function staticFanout(node: Node): number | null {
  const fields = node.fields;
  const literal =
    node.type === "parallel" ? fields.branches : node.type === "pipeline" ? fields.items : null;
  return Array.isArray(literal) ? literal.length : null;
}

export function validateSpec(
  raw: unknown,
  options: ValidateSpecOptions = {},
): WorkflowSpec | ValidationError {
  const issues: SpecIssue[] = [];
  const root = record(raw);
  if (root === null)
    return new ValidationError([
      new SpecIssue({ rule: "type", message: "the spec must be a mapping" }),
    ]);
  const metaRecord = record(root.meta ?? {});
  const meta = metaRecord ?? {};
  if (metaRecord === null) {
    issue(issues, "meta", "meta must be a mapping with at least a name", null, "meta");
  } else {
    if (typeof meta.name !== "string" || meta.name === "") {
      issue(
        issues,
        "meta",
        "meta.name is required and must be a string",
        null,
        "meta.name",
        "meta:\n  name: triage-bugs",
      );
    }
    if (findRefs(meta).length > 0) {
      issue(issues, "meta", "meta must be pure literals — no ${references}", null, "meta");
    }
  }
  const inputs = record(root.inputs) ?? {};
  const schemasRecord = record(root.schemas ?? {});
  const schemas = schemasRecord ?? {};
  if (schemasRecord === null) {
    issue(issues, "schemas", "schemas must be a mapping of name -> JSON-Schema", null, "schemas");
  } else {
    for (const [name, definition] of Object.entries(schemas)) {
      if (record(definition) === null) {
        issue(
          issues,
          "schema_def",
          `schema '${name}' must be a JSON-Schema object`,
          null,
          `schemas.${name}`,
          "schemas:\n  VERDICT: {type: object}",
        );
      }
    }
  }
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
    issue(issues, "nodes", "spec needs a non-empty 'nodes' list", null, "nodes");
    return new ValidationError(issues);
  }

  const nodes: Node[] = [];
  const ids = new Set<string>();
  for (const item of rawNodes) {
    const nodeRecord = record(item);
    if (nodeRecord === null) {
      const index = rawNodes.indexOf(item);
      issue(
        issues,
        "node",
        `node #${String(index)} must be a mapping`,
        null,
        `nodes[${String(index)}]`,
      );
      continue;
    }
    const shaped = validateShape(
      nodeRecord,
      rawNodes.indexOf(item),
      issues,
      options.supportedTypes,
    );
    const candidate = shaped.duplicateCandidate;
    if (candidate !== null && ids.has(candidate)) {
      issue(issues, "dup_id", `duplicate node id '${candidate}'`, candidate);
      continue;
    }
    if (candidate !== null) ids.add(candidate);
    if (shaped.node !== null) nodes.push(shaped.node);
  }

  const knownIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    validateLifecycle(node, issues);
    validateTier(node, issues);
    validateGate(node, issues);
    for (const bad of invalidRefs(node.fields)) {
      issue(
        issues,
        "ref_expression",
        `reference \${${bad}} is not a plain path (no expressions/arithmetic/calls)`,
        node.id,
        null,
        "${scan.ids} or ${args.dump}",
      );
    }
    for (const reference of refsIn(node.fields)) {
      const rootId = reference.split(".", 1)[0];
      if (
        rootId !== undefined &&
        isValidRef(reference) &&
        !["args", "item", "stage", "winner", "round", "so_far"].includes(rootId) &&
        !knownIds.has(rootId)
      ) {
        issue(
          issues,
          "ref_target",
          `reference \${${reference}} points at unknown node '${rootId}'`,
          node.id,
          null,
          "reference an existing node id",
        );
      }
    }
    const schemaRef = node.fields.schema_ref;
    if (typeof schemaRef === "string" && !(schemaRef in schemas)) {
      issue(
        issues,
        "schema_ref",
        `schema_ref '${schemaRef}' has no matching entry in schemas:`,
        node.id,
        "schema_ref",
      );
    }
    const inlineSchema = node.fields.schema;
    if (
      inlineSchema !== undefined &&
      inlineSchema !== null &&
      record(inlineSchema) === null &&
      !(typeof inlineSchema === "string" && inlineSchema in schemas)
    ) {
      issue(
        issues,
        "schema_type",
        "'schema' must be a JSON-Schema object; to reference a named schema use 'schema_ref'",
        node.id,
        "schema",
        "schema_ref: my_schema",
      );
    }
    const count = staticFanout(node);
    if (count !== null && count > MAX_STATIC_FANOUT) {
      issue(
        issues,
        "fanout_cap",
        `static fan-out of ${String(count)} exceeds 64; use a \${ref} (bounded at runtime by the budget)`,
        node.id,
      );
    }
  }

  const cycle = detectCycle(nodes);
  if (cycle !== null)
    issue(issues, "cycle", `dependency cycle: ${cycle.join(" -> ")}`, cycle[0] ?? null);
  if (issues.length > 0) return new ValidationError(issues);
  return new WorkflowSpec({ meta, inputs, schemas, nodes });
}
