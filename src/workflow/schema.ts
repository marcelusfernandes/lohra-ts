import type { WorkflowLoader } from "./engine-contract.js";
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

/**
 * Resolve `fields.schema` the same way `schema_ref` resolves a name: an
 * inline object wins as-is; a string looks itself up in `schemas`; anything
 * else (including an unknown name) is not a schema. Used by the engine's
 * `schemaOf` (`engine.ts`) so `agent`, `gate`, `judge_panel.synthesize` and
 * `loop_until_dry.body` all resolve a named schema the same way (#231) —
 * mirrors, but does not replace, the `schema_type` check on `node.fields.schema`
 * below (key presence in `schemas`, not the same shape check).
 */
export function resolveInlineSchema(
  value: unknown,
  schemas: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const inline = record(value);
  if (inline !== null) return inline;
  return typeof value === "string" ? record(schemas[value]) : null;
}

function checkSchemaXor(issues: SpecIssue[], nodeId: string | null, field: string): void {
  issue(issues, "schema_xor", "use either 'schema' or 'schema_ref', not both", nodeId, field);
}

/**
 * Checks a `schema_ref`/`schema` pair against `schemas:` with the same rule
 * and message text everywhere it appears: the top-level node fields (called
 * from `validateSpec`'s per-node loop with `fieldPrefix: ""`) and the
 * agent-shaped sub-objects scanned by `schemaBearingSubObjects` below
 * (`body`, `synthesize`, `stages[*]`, each with their own `fieldPrefix`).
 */
function checkNamedSchema(
  fields: Readonly<Record<string, unknown>>,
  nodeId: string | null,
  fieldPrefix: string,
  schemas: Readonly<Record<string, unknown>>,
  issues: SpecIssue[],
): void {
  const schemaRef = fields.schema_ref;
  if (typeof schemaRef === "string" && !(schemaRef in schemas)) {
    issue(
      issues,
      "schema_ref",
      `schema_ref '${schemaRef}' has no matching entry in schemas:`,
      nodeId,
      `${fieldPrefix}schema_ref`,
    );
  }
  const inlineSchema = fields.schema;
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
      nodeId,
      `${fieldPrefix}schema`,
      "schema_ref: my_schema",
    );
  }
}

interface SchemaSubObject {
  readonly fieldPrefix: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Agent-shaped sub-objects where `schema`/`schema_ref` are meaningful
 * because the engine's `schemaOf` (`engine.ts:347-355`) reads them off this
 * same object at runtime: `loop_until_dry.body`, `gate.body`,
 * `judge_panel.synthesize` and each `pipeline.stages[*]`. #238 (unknown
 * fields in sub-objects) can reuse this same scan point for its own rule.
 */
function schemaBearingSubObjects(node: Node): readonly SchemaSubObject[] {
  const targets: SchemaSubObject[] = [];
  if (node.type === "gate" || node.type === "loop_until_dry") {
    const body = record(node.fields.body);
    if (body !== null) targets.push({ fieldPrefix: "body.", fields: body });
  }
  if (node.type === "judge_panel") {
    const synthesize = record(node.fields.synthesize);
    if (synthesize !== null) targets.push({ fieldPrefix: "synthesize.", fields: synthesize });
  }
  if (node.type === "pipeline" && Array.isArray(node.fields.stages)) {
    node.fields.stages.forEach((stage, index) => {
      const stageRecord = record(stage);
      if (stageRecord !== null) {
        targets.push({ fieldPrefix: `stages[${String(index)}].`, fields: stageRecord });
      }
    });
  }
  return targets;
}

function validateSubObjectSchemas(
  node: Node,
  schemas: Readonly<Record<string, unknown>>,
  issues: SpecIssue[],
): void {
  for (const target of schemaBearingSubObjects(node)) {
    if ("schema" in target.fields && "schema_ref" in target.fields) {
      checkSchemaXor(issues, node.id, `${target.fieldPrefix}schema_ref`);
    }
    checkNamedSchema(target.fields, node.id, target.fieldPrefix, schemas, issues);
  }
}

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
    const citedType = nodeType === undefined ? "undefined" : JSON.stringify(nodeType);
    issue(
      issues,
      "node_type",
      `unknown node type ${citedType}`,
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
    checkSchemaXor(issues, id, "schema_ref");
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
    checkNamedSchema(node.fields, node.id, "", schemas, issues);
    // #238 (unknown fields in sub-objects) reuses this same scan point —
    // schemaBearingSubObjects above already enumerates body/synthesize/stages.
    validateSubObjectSchemas(node, schemas, issues);
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

/**
 * Resolves every `workflow` node's `ref` through `loader` and validates the
 * result with `validateSpec`, so a nested template that is wrong fails the
 * LAUNCH (issue #244) instead of surfacing only when that node executes
 * (the pre-existing backstop in `engine.ts`'s `runNested`, which stays —
 * `loader` can answer differently between this call and execution).
 *
 * Only checkable here: a literal `ref` string (one with no `${...}`
 * expression — those need the run's context, which does not exist yet at
 * launch) and a `loader` that answers synchronously (a Promise is left
 * entirely to the runtime backstop, its rejection swallowed on purpose so
 * an async loader never turns an unrelated launch into an unhandled
 * rejection). `depth` mirrors the engine's own `MAX_WORKFLOW_DEPTH` cap: at
 * that depth the engine throws before it ever calls `loader` again, so this
 * stops recursing there too instead of reporting a ref issue that was never
 * the engine's to raise.
 */
export function validateNestedRefs(
  spec: WorkflowSpec,
  loader: WorkflowLoader | undefined,
  depth = 0,
): ValidationError | null {
  void spec;
  void loader;
  void depth;
  throw new Error("not implemented: validateNestedRefs");
}
