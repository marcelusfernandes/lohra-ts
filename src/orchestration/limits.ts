import { pythonRepr } from "../serialization/python-repr.js";

export interface EnvClampResult {
  readonly value: number;
  readonly warning: string | null;
}

/**
 * Mirrors Python's int(str): optional sign, digits only, surrounding
 * whitespace trimmed, with a single underscore allowed as a digit separator
 * between digits (PEP 515) — "1_0" parses as 10, but "_10", "10_" and "1__0"
 * are all rejected, same as the oracle. Rejects decimals ("3.0") and
 * non-numeric strings alike — both fall into the same "not an integer"
 * branch as the oracle.
 */
function pythonInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(trimmed)) return null;
  return Number(trimmed.replace(/_/g, ""));
}

/**
 * Reproduces _positive_int_env: unset/empty falls back silently, an
 * unparseable value warns "not an integer", a parsed value below 1 warns
 * "must be >= 1" — both warnings cite the per-variable default, never a
 * shared constant. The raw value in the warning is Python's repr() of the
 * original string (the oracle's `%r` formatting), never the trimmed value
 * and never verbatim interpolation — a raw value containing a quote,
 * backslash, or control character diverges from a naive template.
 */
export function positiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): EnvClampResult {
  if (!raw) return { value: fallback, warning: null };
  const parsed = pythonInt(raw);
  if (parsed === null) {
    return {
      value: fallback,
      warning: `ignoring ${name}=${pythonRepr(raw)}: not an integer; using ${String(fallback)}`,
    };
  }
  if (parsed < 1) {
    return {
      value: fallback,
      warning: `ignoring ${name}=${pythonRepr(raw)}: must be >= 1; using ${String(fallback)}`,
    };
  }
  return { value: parsed, warning: null };
}

/**
 * The CLI-flag clamp rule: an integer <= 0 floors to 1, never falls back to
 * a default. Throws on non-integer input rather than truncating — the
 * oracle's argparse(type=int) rejects a non-integer flag value outright
 * (exit 2, usage message) before any clamping runs, so a non-integer must
 * never reach this function on the real CLI path. The strict integer check
 * belongs to the flag parser built alongside the CLI wiring, not here.
 */
export function clampFlagMinOne(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error(`clampFlagMinOne requires an integer, got ${String(value)}`);
  }
  return Math.max(1, value);
}
