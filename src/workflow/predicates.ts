import type { SpecIssue } from "./types.js";

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

export function validatePredicate(
  value: unknown,
  nodeId: string | null,
  field: string,
): readonly SpecIssue[] {
  void value;
  void nodeId;
  void field;
  throw new Error("not implemented: validatePredicate");
}

export function evaluatePredicate(
  predicate: Predicate,
  context: Readonly<Record<string, unknown>>,
): boolean {
  void predicate;
  void context;
  throw new Error("not implemented: evaluatePredicate");
}
