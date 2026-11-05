import { findRefs, isValidRef, readPath } from "./refs.js";
import { SpecIssue } from "./types.js";

/**
 * Mechanical predicates over the run state (épico #976, design §2 and §4). A predicate is
 * an object with exactly one key — its name — whose value holds the fields:
 * `{field_equals: {path: "${scan.verdict}", value: "ok"}}`. `path` is exactly one `${ref}`
 * and is read with `readPath`, so it sees what `${ref}` renders (a JSON string and an
 * array index are traversed; an absent field is `null`). Operands are literals — there is
 * no `${}` in them and no `and`/`or`: chain nodes instead.
 */
export const PREDICATE_NAMES = Object.freeze([
  "field_equals",
  "field_true",
  "in",
  "gte",
  "lt",
  "count_gte",
  "empty",
  "field_type",
  "not",
] as const);
export type PredicateName = (typeof PREDICATE_NAMES)[number];

export const MAX_PREDICATE_VALUES = 64;
export const PREDICATE_TYPES = Object.freeze([
  "number",
  "string",
  "boolean",
  "array",
  "object",
  "null",
] as const);
export type PredicateType = (typeof PREDICATE_TYPES)[number];

export type PredicateScalar = string | number | boolean | null;

export type LeafPredicate =
  | { readonly field_equals: { readonly path: string; readonly value: PredicateScalar } }
  | { readonly field_true: { readonly path: string } }
  | { readonly in: { readonly path: string; readonly values: readonly PredicateScalar[] } }
  | { readonly gte: { readonly path: string; readonly n: number } }
  | { readonly lt: { readonly path: string; readonly n: number } }
  | { readonly count_gte: { readonly path: string; readonly n: number } }
  | { readonly empty: { readonly path: string } }
  | { readonly field_type: { readonly path: string; readonly type: PredicateType } };

export type Predicate = LeafPredicate | { readonly not: { readonly of: LeafPredicate } };

type Body = Readonly<Record<string, unknown>>;
type LeafName = Exclude<PredicateName, "not">;

const SINGLE_REF = /^\$\{([^}]*)\}$/u;

const plainRecord = (value: unknown): Body | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Body) : null;

const isPredicateName = (name: string): name is PredicateName =>
  (PREDICATE_NAMES as readonly string[]).includes(name);

const isScalar = (value: unknown): value is PredicateScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** The bare reference of a `path` that is exactly one `${ref}`; `null` for anything else. */
export function pathRef(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const inner = SINGLE_REF.exec(path)?.[1];
  return inner !== undefined && isValidRef(inner) ? inner : null;
}

interface Problem {
  /** Appended to the operand's field: `""` for the operand itself, `[2]` for an item. */
  readonly at: string;
  readonly message: string;
}
type OperandCheck = (value: unknown) => readonly Problem[];

const problem = (message: string, at = ""): readonly Problem[] => [{ at, message }];

function scalarProblems(value: unknown, label: string, at = ""): readonly Problem[] {
  if (!isScalar(value))
    return problem(`'${label}' must be a string, a finite number, a boolean or null`, at);
  if (typeof value === "string" && findRefs(value).length > 0)
    return problem(`'${label}' is a literal: no \${ref} — operands are never resolved`, at);
  return [];
}

const checkPath: OperandCheck = (value) =>
  pathRef(value) === null
    ? problem("'path' must be exactly one ${ref} — no text around it, no expression, no call")
    : [];

const checkValue: OperandCheck = (value) => scalarProblems(value, "value");

const checkValues: OperandCheck = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PREDICATE_VALUES)
    return problem(`'values' must be a list of 1 to ${String(MAX_PREDICATE_VALUES)} scalars`);
  return value.flatMap((item: unknown, index) =>
    scalarProblems(item, `values[${String(index)}]`, `[${String(index)}]`),
  );
};

const checkFinite: OperandCheck = (value) =>
  typeof value === "number" && Number.isFinite(value) ? [] : problem("'n' must be a finite number");

const checkCount: OperandCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? []
    : problem("'n' must be a whole number, 0 or more");

const checkType: OperandCheck = (value) =>
  typeof value === "string" && (PREDICATE_TYPES as readonly string[]).includes(value)
    ? []
    : problem(`'type' must be one of [${PREDICATE_TYPES.map((type) => `'${type}'`).join(", ")}]`);

/** Every field of a predicate is required; the table is also the list of fields it may have. */
const RULES: Readonly<Record<LeafName, readonly (readonly [string, OperandCheck])[]>> = {
  field_equals: [
    ["path", checkPath],
    ["value", checkValue],
  ],
  field_true: [["path", checkPath]],
  in: [
    ["path", checkPath],
    ["values", checkValues],
  ],
  gte: [
    ["path", checkPath],
    ["n", checkFinite],
  ],
  lt: [
    ["path", checkPath],
    ["n", checkFinite],
  ],
  count_gte: [
    ["path", checkPath],
    ["n", checkCount],
  ],
  empty: [["path", checkPath]],
  field_type: [
    ["path", checkPath],
    ["type", checkType],
  ],
};

const EXAMPLES: Readonly<Record<PredicateName, string>> = {
  field_equals: '{field_equals: {path: "${review.verdict}", value: "approved"}}',
  field_true: '{field_true: {path: "${review.ok}"}}',
  in: '{in: {path: "${review.verdict}", values: ["approved", "skip"]}}',
  gte: '{gte: {path: "${review.score}", n: 8}}',
  lt: '{lt: {path: "${review.score}", n: 5}}',
  count_gte: '{count_gte: {path: "${scan.items}", n: 3}}',
  empty: '{empty: {path: "${scan.items}"}}',
  field_type: '{field_type: {path: "${scan.items}", type: "array"}}',
  not: '{not: {of: {field_true: {path: "${review.ok}"}}}}',
};

const NAME_LIST = PREDICATE_NAMES.map((name) => `'${name}'`).join(", ");

function validateInto(
  value: unknown,
  nodeId: string | null,
  field: string,
  insideNot: boolean,
  issues: SpecIssue[],
): void {
  const refuse = (rule: string, message: string, at: string, example: string): void => {
    issues.push(new SpecIssue({ rule, message, nodeId, field: at, example }));
  };
  const record = plainRecord(value);
  const keys = record === null ? [] : Object.keys(record);
  const name = keys[0];
  if (record === null || keys.length !== 1 || name === undefined) {
    refuse(
      "field_value",
      `a predicate is an object with exactly one key, one of [${NAME_LIST}]`,
      field,
      EXAMPLES.field_true,
    );
    return;
  }
  if (!isPredicateName(name)) {
    const hint =
      name === "and" || name === "or" ? " — there is no and/or: chain nodes instead" : "";
    refuse(
      "unknown_field",
      `unknown predicate '${name}'${hint}`,
      `${field}.${name}`,
      `one of [${NAME_LIST}], e.g. ${EXAMPLES.field_true}`,
    );
    return;
  }
  const at = `${field}.${name}`;
  const body = plainRecord(record[name]);
  const example = EXAMPLES[name];
  if (name === "not") {
    if (insideNot) {
      refuse("field_value", "'not' cannot wrap another 'not'", at, example);
      return;
    }
    if (body === null) {
      refuse("field_value", "'not' takes an object with 'of'", at, example);
      return;
    }
    for (const key of Object.keys(body).filter((candidate) => candidate !== "of"))
      refuse("unknown_field", `'not' has no field '${key}'`, `${at}.${key}`, example);
    if (Object.hasOwn(body, "of")) validateInto(body.of, nodeId, `${at}.of`, true, issues);
    else refuse("missing_field", "'not' requires 'of'", `${at}.of`, example);
    return;
  }
  const rules = RULES[name];
  if (body === null) {
    const fields = rules.map(([key]) => `'${key}'`).join(", ");
    refuse("field_value", `'${name}' takes an object with ${fields}`, at, example);
    return;
  }
  for (const key of Object.keys(body).filter((key) => !rules.some(([known]) => known === key)))
    refuse("unknown_field", `'${name}' has no field '${key}'`, `${at}.${key}`, example);
  for (const [key, check] of rules) {
    if (!Object.hasOwn(body, key)) {
      refuse("missing_field", `'${name}' requires '${key}'`, `${at}.${key}`, example);
      continue;
    }
    for (const found of check(body[key]))
      refuse("field_value", found.message, `${at}.${key}${found.at}`, example);
  }
}

/**
 * The refusals of design §4, each a `SpecIssue` with rule, field and an example to copy:
 * an unknown name or a field the predicate does not have, a `path` that is not exactly one
 * `${ref}`, a `${}` inside an operand, `values` that are not 1 to 64 scalars, an `n` that is
 * not finite (or, for `count_gte`, not a whole number >= 0), a `type` outside the six, and
 * a `not` inside a `not`. `field` is where the predicate sits (`when`, `until`), and every
 * issue's field extends it (`when.in.values[2]`).
 */
export function validatePredicate(
  value: unknown,
  nodeId: string | null,
  field: string,
): readonly SpecIssue[] {
  const issues: SpecIssue[] = [];
  validateInto(value, nodeId, field, false, issues);
  return issues;
}

function singleEntry(predicate: unknown): readonly [string, Body] {
  const record = plainRecord(predicate);
  const entries = record === null ? [] : Object.entries(record);
  const entry = entries[0];
  const body = plainRecord(entry?.[1]);
  if (entries.length !== 1 || entry === undefined || body === null)
    throw new Error("predicate must be an object with exactly one key holding an object");
  return [entry[0], body];
}

function operand(name: string, body: Body, key: string): unknown {
  if (!Object.hasOwn(body, key)) throw new Error(`predicate '${name}' needs '${key}'`);
  return body[key];
}

function numberOperand(name: string, body: Body, key: string): number {
  const value = operand(name, body, key);
  if (typeof value !== "number") throw new Error(`predicate '${name}': '${key}' is not a number`);
  return value;
}

function jsonType(value: unknown): PredicateType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
    case "bigint":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      throw new Error(`a ${typeof value} in the state has no JSON type`);
  }
}

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (plainRecord(value) !== null && Object.keys(value as Body).length === 0);

function evaluateNamed(name: string, body: Body, context: Body, insideNot: boolean): boolean {
  const read = (): unknown => {
    const reference = pathRef(operand(name, body, "path"));
    if (reference === null) throw new Error(`predicate '${name}': path is not exactly one \${ref}`);
    return readPath(reference, context);
  };
  switch (name) {
    case "field_equals":
      return read() === operand(name, body, "value");
    case "field_true":
      return read() === true;
    case "in": {
      const values = operand(name, body, "values");
      if (!Array.isArray(values)) throw new Error("predicate 'in': 'values' is not a list");
      const found = read();
      return isScalar(found) && values.includes(found);
    }
    case "gte": {
      const found = read();
      return (
        typeof found === "number" &&
        Number.isFinite(found) &&
        found >= numberOperand(name, body, "n")
      );
    }
    case "lt": {
      const found = read();
      return (
        typeof found === "number" &&
        Number.isFinite(found) &&
        found < numberOperand(name, body, "n")
      );
    }
    case "count_gte": {
      const found = read();
      return Array.isArray(found) && found.length >= numberOperand(name, body, "n");
    }
    case "empty":
      return isEmptyValue(read());
    case "field_type":
      return jsonType(read()) === operand(name, body, "type");
    case "not": {
      if (insideNot) throw new Error("predicate 'not' cannot wrap another 'not'");
      const [innerName, innerBody] = singleEntry(operand(name, body, "of"));
      return !evaluateNamed(innerName, innerBody, context, true);
    }
    default:
      throw new Error(`unknown predicate '${name}'`);
  }
}

/**
 * Whether `predicate` holds over `context` (the node context: `{args, ...outputs}`, plus
 * any locals the caller adds). Total over `PREDICATE_NAMES`: a name outside them, a shape
 * that is not one name with a body, or a path that is not exactly one `${ref}` throws —
 * `validatePredicate` is what keeps a spec from ever getting here.
 */
export function evaluatePredicate(
  predicate: Predicate,
  context: Readonly<Record<string, unknown>>,
): boolean {
  const [name, body] = singleEntry(predicate);
  return evaluateNamed(name, body, context, false);
}
