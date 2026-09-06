// Aliased: limits.ts still exports the old name; renaming it is #73's call.
import { clampFlagMinOne, positiveIntEnv, pythonInt as parseIntStrict } from "./limits.js";

export interface FanoutResolution {
  readonly maxParallel: number;
  readonly maxSubsessions: number;
  readonly parentMaxIterations: number;
  readonly warnings: readonly string[];
}

/**
 * Resolves the three fan-out/leash knobs — contract assertion 24 (the
 * 13-row clamp table), 26 (flag > env, both directions), 27
 * (LOHRA_MAX_SUBSESSIONS is env-only, no flag anywhere), and 29 (the
 * parent's own default leash, measured as 90 with nothing configured).
 *
 * --max-parallel (flag) is CLAMPED to >= 1 and never falls back to a
 * default; LOHRA_MAX_PARALLEL (env) FALLS BACK to 4 on any invalid value.
 * The two channels behave OPPOSITELY on the identical raw input (0/-5) —
 * that asymmetry is the point of the measured table, not something to
 * unify for "consistency". --max-iterations (already parsed by chat.ts's
 * own finite()) is passed in pre-resolved; when absent, this falls back to
 * LOHRA_MAX_ITERATIONS the same way, with 90 as the parent's own default —
 * previously this fell through to ConversationRuntime's own internal
 * default of 128 when the flag was absent, which the measured baseline
 * contradicts.
 *
 * A non-integer --max-parallel value throws CHAT_OPTION_INVALID:max-parallel
 * rather than clamping or silently falling back — mirroring the existing
 * (already uncaught upstream, not this ticket's to fix) convention
 * chat.ts's own finite() uses for --temperature/--max-iterations. The
 * oracle's own non-integer-flag message was not measured in this baseline;
 * this is a consistency choice with the surrounding file, not a byte-exact
 * claim.
 */
export function resolveFanout(
  maxParallelFlag: string | undefined,
  maxIterationsFlag: number | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): FanoutResolution {
  const warnings: string[] = [];

  let maxParallel: number;
  if (maxParallelFlag !== undefined) {
    const parsed = parseIntStrict(maxParallelFlag);
    if (parsed === null) throw new Error("CHAT_OPTION_INVALID:max-parallel");
    maxParallel = clampFlagMinOne(parsed);
  } else {
    const result = positiveIntEnv("LOHRA_MAX_PARALLEL", environment.LOHRA_MAX_PARALLEL, 4);
    maxParallel = result.value;
    if (result.warning !== null) warnings.push(result.warning);
  }

  const subsessions = positiveIntEnv(
    "LOHRA_MAX_SUBSESSIONS",
    environment.LOHRA_MAX_SUBSESSIONS,
    200,
  );
  if (subsessions.warning !== null) warnings.push(subsessions.warning);

  let parentMaxIterations: number;
  if (maxIterationsFlag !== undefined) {
    parentMaxIterations = maxIterationsFlag;
  } else {
    const result = positiveIntEnv("LOHRA_MAX_ITERATIONS", environment.LOHRA_MAX_ITERATIONS, 90);
    parentMaxIterations = result.value;
    if (result.warning !== null) warnings.push(result.warning);
  }

  return { maxParallel, maxSubsessions: subsessions.value, parentMaxIterations, warnings };
}
