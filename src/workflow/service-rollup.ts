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
import type { AuditedChildRuntime } from "./audit-runtime.js";
import type { ProgressSnapshot } from "./progress.js";
import type { RouteOverride } from "./route-override.js";
// Re-exported (not just imported) so service.ts's own import from THIS
// module — already needed for `resultView`/`runningView` — can pull
// `nextPivots` in too, instead of wrapping a second import statement onto
// its own zero-growth budget for one more name (#448).
export { nextPivots } from "./route-override.js";

/** Issue #424 (M10-S3): `workflow_steer` needs the SAME per-stretch decorator
 * `WorkflowService.launch`/`launchDurable` installed on a run's `RunRecord`
 * (`record.runtime`, assigned right after `makeRecord` returns — never
 * present in the object literal itself, which is why the field type below
 * carries `| undefined`) — a fresh `auditedRuntimeFor`/`auditInstall` call
 * would mint an empty `identities` map and silently drop `leaf.steered`
 * (audit-runtime.ts's fail-open-to-the-port branch). `undefined` for an
 * unknown OR already-settled run — a settled run's leaves are gone. */
export function liveRuntimeOf<
  T extends Readonly<{ settled: boolean; runtime?: AuditedChildRuntime }>,
>(runs: ReadonlyMap<string, T>, runId: string): AuditedChildRuntime | undefined {
  const record = runs.get(runId);
  return record !== undefined && !record.settled ? record.runtime : undefined;
}

/** Structural, not `RunRecord` (service.ts) itself — same reasoning as
 * `PriorPauseView` (route-override.ts): importing the real interface would
 * make service.ts and service-rollup.ts import each other. `pivots` is
 * computed once at launch (`nextPivots`, service.ts) and assigned right
 * after `makeRecord` returns — same as `runtime` (#424) — hence `| undefined`. */
interface LiveRunLike {
  readonly id: string;
  readonly name: string;
  readonly engine: Readonly<{ budget: Budget; progress(): ProgressSnapshot }>;
  readonly pivots?: readonly RouteOverride[];
}

/** #448: `pivots` is OMITTED (never a bare `[]`) for a run that never
 * pivoted — the same idiom `durableRollup` (service.ts) already uses, so a
 * run's live and durable envelopes agree on absence, not just on content. */
function withPivots(
  view: Readonly<Record<string, unknown>>,
  pivots: readonly RouteOverride[],
): Readonly<Record<string, unknown>> {
  return pivots.length === 0 ? view : { ...view, pivots: [...pivots] };
}

/** The one terminal/live view every read channel (`status()`, `runAndWait`,
 * the in-process settle path) converges on for a run whose `RunResult` is
 * in memory. `faults` folds in `sandboxFaults` (#246) — advisory sandbox
 * refusals are visible here but never fed `deriveStatus`, which reads only
 * `RunResult.faults`. */
export function resultView(
  record: LiveRunLike,
  result: RunResult,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    withPivots(
      {
        run_id: record.id,
        name: record.name,
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
        token_budget: record.engine.budget.snapshot(),
        null_rate: result.nullRate,
        usage_uncertain_leaves: result.usageUncertainLeaves,
        sandbox_refusals: result.sandboxRefusals,
        fault_kinds: [...result.faultKinds],
      },
      record.pivots ?? [],
    ),
  );
}

/** #448: the still-"running" snapshot `WorkflowService.status` answers for a
 * record that exists but hasn't settled yet (`record.result === null`) —
 * the SAME `pivots` `resultView` carries once it does, never a second
 * derivation of `nextPivots`'s append rule. */
export function runningView(record: LiveRunLike): Readonly<Record<string, unknown>> {
  return Object.freeze(
    withPivots(
      {
        run_id: record.id,
        name: record.name,
        status: "running",
        progress: record.engine.progress(),
        token_budget: record.engine.budget.snapshot(),
      },
      record.pivots ?? [],
    ),
  );
}
