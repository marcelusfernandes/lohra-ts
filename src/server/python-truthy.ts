/** Python's notion of falsy, for JSON-shaped values arriving from a client
 * that a Python oracle would evaluate with `if value:` — `None`, `False`,
 * `0`, `""`, `[]`, `{}` are all falsy; everything else, including any
 * non-empty string like `"yes"`, is truthy (contract v2 assertion 27:
 * `stream_options.include_usage:"yes"` must count as truthy). */
export function isPythonFalsy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function isPythonTruthy(value: unknown): boolean {
  return !isPythonFalsy(value);
}
