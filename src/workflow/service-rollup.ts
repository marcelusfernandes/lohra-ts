// `resultView` used to live in service.ts. Issue #246 needed one more field
// on it (`sandbox_refusals`) and service.ts was already at its
// `arquivo-grande` base (1370 lines, zero-growth budget) — same shape as the
// #241/#242 precedent that put per-branch parallel logic in engine-utils.ts
// instead of engine.ts. This sibling module is the same move for the
// service side: a plain, dependency-free function has nothing to gain from
// living inside the class file, so it moved wholesale rather than leaving a
// thin re-export behind.
import type { Budget } from "./budget.js";
import type { RunResult } from "./accounting.js";

/** The one terminal/live view every read channel (`status()`, `runAndWait`,
 * the in-process settle path) converges on for a run whose `RunResult` is
 * in memory. `faults` folds in `sandboxFaults` (#246) — advisory sandbox
 * refusals are visible here but never fed `deriveStatus`, which reads only
 * `RunResult.faults`. */
export function resultView(
  runId: string,
  name: string,
  result: RunResult,
  budget: Budget,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    run_id: runId,
    name,
    status: result.status,
    outputs: structuredClone(result.outputs),
    faults: Object.freeze([...result.faults, ...result.sandboxFaults]),
    null_count: result.nullCount,
    leaf_respawns: result.leafRespawns,
    validation_retries: result.validationRetries,
    cap_trips: result.capTrips,
    engine_faults: result.engineFaults,
    nodes_total: result.nodesTotal,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    cache_read_tokens: result.cacheReadTokens,
    cache_write_tokens: result.cacheWriteTokens,
    reasoning_tokens: result.reasoningTokens,
    forcing_fallbacks: result.forcingFallbacks,
    pause_reason: result.pauseReason,
    checkpoint: result.checkpoint,
    token_budget: budget.snapshot(),
    null_rate: result.nullRate,
    usage_uncertain_leaves: result.usageUncertainLeaves,
    sandbox_refusals: result.sandboxRefusals,
    fault_kinds: [...result.faultKinds],
  });
}
