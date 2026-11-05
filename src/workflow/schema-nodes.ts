import { MAX_GATE_ATTEMPTS } from "./nodes.js";
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

export function validateGate(node: Node, issues: SpecIssue[]): void {
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

export const validateSwitch: NodeValidator = () => {
  throw new Error("not implemented: validateSwitch");
};

export const NODE_VALIDATORS: ReadonlyMap<string, NodeValidator> = new Map([
  ["gate", validateGate],
]);

/** Runs the validator of `node.type`, if that type has one. */
export function validateByType(node: Node, issues: SpecIssue[]): void {
  NODE_VALIDATORS.get(node.type)?.(node, issues);
}
