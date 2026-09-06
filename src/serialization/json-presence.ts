/**
 * Presence rule for JSON-shaped values used across this runtime: a value
 * counts as empty when it is absent (`undefined`/`null`), `false`, `0`,
 * `""`, `[]`, or `{}`. Everything else — including non-empty strings like
 * `"no"`, non-zero numbers, non-empty arrays/objects, and `true` — counts
 * as present. This is a decision of this runtime's protocol, not a
 * dependency on any other implementation.
 */
export function isEmptyJsonValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function hasJsonValue(value: unknown): boolean {
  return !isEmptyJsonValue(value);
}
