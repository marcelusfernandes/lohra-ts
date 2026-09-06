import { jsonFloat, stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";

/** Formats a float for `cron list`'s stdout line: same digit precision as JSON's float
 * encoding, but with distinct lowercase tokens (`nan`/`inf`/`-inf`) for the three
 * non-finite values instead of JSON's own representation. This is human-facing text
 * (cron list's stdout, not a JSON output boundary — docs/adr/0003-native-wire-format.md,
 * "Human-facing text"), so non-finite values are formatted directly instead of going through
 * `stringifyJsonPreservingNumbers` (which throws for them at JSON write boundaries). */
export function formatFloatForCron(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  return stringifyJsonPreservingNumbers(jsonFloat(value));
}

/**
 * The `(type=value)` fragment of `cron list`'s stdout line. `interval` is always an integer
 * (never a decimal point); `once` is always a float (always a decimal point, or `nan`/`inf`);
 * `cron` is a plain string expression. Getting this wrong for `once` is exactly the
 * "(once=nan)" golden.
 */
export function formatJobValue(type: string, value: unknown): string {
  if (type === "once" && typeof value === "number") return formatFloatForCron(value);
  return String(value);
}
