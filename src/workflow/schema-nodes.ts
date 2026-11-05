import { MAX_GATE_ATTEMPTS, MAX_SWITCH_CASES } from "./nodes.js";
import { pathRef } from "./predicates.js";
import { SpecIssue, type Node } from "./types.js";

/**
 * Per-type validation of a node's own fields, called by `validateSpec` (`schema.ts`) once
 * per node. A node type with rules of its own adds its validator here and one entry to
 * `NODE_VALIDATORS` — `schema.ts` is at its size limit and must not grow (épico #976).
 * Cross-cutting checks (knobs, tiers, refs, sub-object fields) stay in `schema.ts`.
 */
export type NodeValidator = (node: Node, issues: SpecIssue[]) => void;

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function issue(
  issues: SpecIssue[],
  rule: string,
  message: string,
  nodeId: string | null = null,
  field: string | null = null,
  example: string | null = null,
): void {
  issues.push(new SpecIssue({ rule, message, nodeId, field, example }));
}

/** An agent-shaped body: an object carrying a `prompt` that is not blank (or falsy). */
function hasPrompt(body: Record<string, unknown> | null): boolean {
  if (body === null || !("prompt" in body)) return false;
  const prompt = body.prompt;
  return typeof prompt === "string"
    ? prompt.trim() !== ""
    : prompt !== undefined && prompt !== null && prompt !== false && prompt !== 0;
}

export function validateGate(node: Node, issues: SpecIssue[]): void {
  if (node.type !== "gate") return;
  const body = record(node.fields.body);
  if (!hasPrompt(body)) {
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

const SWITCH_CASES_EXAMPLE =
  'cases:\n  reuse: null\n  investigate: {prompt: "Dig into ${args.text}"}';

/**
 * `switch` (#979): `value` is exactly one `${ref}` (read with `readPath`, so it sees what a
 * prompt would render); `cases` maps 2 to `MAX_SWITCH_CASES` names to `null` (a branch that
 * runs nothing) or to an agent-shaped body with a `prompt`; `otherwise` names one of them.
 * A case body's own fields, knobs and schemas are checked by `schema.ts`
 * (`schemaBearingSubObjects`) like any agent-shaped sub-object, and a routing knob inside a
 * case is refused there — it goes on the node. A missing `value`/`cases` is `missing_field`.
 */
export function validateSwitch(node: Node, issues: SpecIssue[]): void {
  if (node.type !== "switch") return;
  const { value, cases: rawCases, otherwise } = node.fields;
  if (value !== undefined && pathRef(value) === null) {
    issue(
      issues,
      "field_value",
      "'value' must be exactly one ${ref} to the field the switch reads — no text around it, no expression",
      node.id,
      "value",
      'value: "${scan.verdict}"',
    );
  }
  const cases = record(rawCases);
  const names = cases === null ? [] : Object.keys(cases);
  if (
    rawCases !== undefined &&
    (cases === null || names.length < 2 || names.length > MAX_SWITCH_CASES)
  ) {
    issue(
      issues,
      "field_value",
      `'cases' must be a mapping of 2 to ${String(MAX_SWITCH_CASES)} case names, each null (runs nothing) or an agent-shaped object with a 'prompt'`,
      node.id,
      "cases",
      SWITCH_CASES_EXAMPLE,
    );
  }
  for (const name of names) {
    const body = cases?.[name];
    if (body === null || hasPrompt(record(body))) continue;
    issue(
      issues,
      "field_value",
      `'cases.${name}' must be null (a branch that runs nothing) or an agent-shaped object with a 'prompt'`,
      node.id,
      `cases.${name}`,
      `cases:\n  ${name}: {prompt: "Dig into the cause"}`,
    );
  }
  if (
    otherwise !== undefined &&
    (typeof otherwise !== "string" || cases === null || !Object.hasOwn(cases, otherwise))
  ) {
    issue(
      issues,
      "field_value",
      "'otherwise' must name one of the 'cases' — the one that runs when no case matches the value",
      node.id,
      "otherwise",
      'otherwise: "investigate"',
    );
  }
}

/** `loop` (#980). Stub until the green commit. */
export function validateLoop(node: Node, _issues: SpecIssue[]): void {
  if (node.type !== "loop") return;
  throw new Error("not implemented: validateLoop");
}

export const NODE_VALIDATORS: ReadonlyMap<string, NodeValidator> = new Map([
  ["gate", validateGate],
  ["switch", validateSwitch],
  ["loop", validateLoop],
]);

/** Runs the validator of `node.type`, if that type has one. */
export function validateByType(node: Node, issues: SpecIssue[]): void {
  NODE_VALIDATORS.get(node.type)?.(node, issues);
}
