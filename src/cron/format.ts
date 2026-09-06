import { jsonFloat } from "../serialization/json-numbers.js";
import { pythonJsonDumps } from "../serialization/python-json.js";

/** CPython's `str(float)` — same digit precision as JSON's float encoding, different tokens
 * for the three special values (`nan`/`inf`/`-inf`, lowercase, vs JSON's `NaN`/`Infinity`). */
export function pythonFloatStr(value: number): string {
  const json = pythonJsonDumps(jsonFloat(value));
  if (json === "NaN") return "nan";
  if (json === "Infinity") return "inf";
  if (json === "-Infinity") return "-inf";
  return json;
}

/**
 * The `(type=value)` fragment of `cron list`'s stdout line. `interval` is a Python int (never a
 * decimal point); `once` is always a Python float (always a decimal point, or `nan`/`inf`); `cron`
 * is a plain string expression. Getting this wrong for `once` is exactly the "(once=nan)" golden.
 */
export function formatJobValue(type: string, value: unknown): string {
  if (type === "once" && typeof value === "number") return pythonFloatStr(value);
  return String(value);
}
