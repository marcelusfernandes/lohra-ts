/** Python truthiness for JSON-shaped values. */
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
