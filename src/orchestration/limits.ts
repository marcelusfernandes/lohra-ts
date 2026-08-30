export interface EnvClampResult {
  readonly value: number;
  readonly warning: string | null;
}

/**
 * Mirrors Python's int(str): optional sign, digits only, surrounding
 * whitespace trimmed. Rejects decimals ("3.0") and non-numeric strings alike
 * — both fall into the same "not an integer" branch as the oracle.
 */
function pythonInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Reproduces _positive_int_env: unset/empty falls back silently, an
 * unparseable value warns "not an integer", a parsed value below 1 warns
 * "must be >= 1" — both warnings cite the per-variable default, never a
 * shared constant.
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
      warning: `ignoring ${name}='${raw}': not an integer; using ${String(fallback)}`,
    };
  }
  if (parsed < 1) {
    return {
      value: fallback,
      warning: `ignoring ${name}='${raw}': must be >= 1; using ${String(fallback)}`,
    };
  }
  return { value: parsed, warning: null };
}

/** The CLI-flag clamp rule: invalid values floor to 1, never fall back to a default. */
export function clampFlagMinOne(value: number): number {
  return Math.max(1, Math.trunc(value));
}
