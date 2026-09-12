// `resultView` used to live in service.ts. Issue #246 needed one more field
// on it (`sandbox_refusals`) and service.ts was already at its
// `arquivo-grande` base (1370 lines, zero-growth budget) — same shape as the
// #241/#242 precedent that put per-branch parallel logic in engine-utils.ts
// instead of engine.ts. This sibling module is the same move for the
// service side: a plain, dependency-free function has nothing to gain from
// living inside the class file, so it moved wholesale rather than leaving a
// thin re-export behind.
import type { Budget } from "./budget.js";
import type { RunArtifact, RunResult } from "./accounting.js";
import type { AuditedChildRuntime } from "./audit-runtime.js";
import type { ProgressSnapshot } from "./progress.js";
import type { RouteOverride } from "./route-override.js";
import { ROUTE_FAULT_REASON } from "./route-faults.js";
import type { WorkflowSpec } from "./types.js";
// Re-exported (not just imported) so service.ts's own import from THIS
// module — already needed for `resultView`/`runningView` — can pull
// `nextPivots`/`artifactsOf` in too, instead of wrapping a second import
// statement onto its own zero-growth budget for one more name (#448, #463).
export { nextPivots, artifactsOf } from "./route-override.js";

// #463: moved here alongside `pauseFields` below — service.ts's own
// zero-growth ceiling has no room for both the six lines these constants
// occupied AND the new `artifacts`/`artifact_faults` fields (issue #463) —
// re-exported from service.ts (`export { … } from "./service-rollup.js"`)
// so `commands/workflow.ts` and existing tests keep importing them from
// `service.js` unchanged.
export const CHECKPOINT_PAUSE = "checkpoint";
export const TOKEN_BUDGET_PAUSE = "token_budget_exhausted";
export const USER_PAUSE = "user_requested";
export const TOKEN_BUDGET_HINT =
  "the run spent its token budget; nothing will resume it on its own — " +
  "run_workflow(resume_run_id=..., token_budget=<more than 'spent'>)";
export const CHECKPOINT_HINT =
  "this run is paused at a checkpoint waiting for your answer — " +
  'run_workflow(resume_run_id=..., checkpoint_answers={"<node_id>": ' +
  '<answer>}) — a nested checkpoint\'s node_id is scoped (e.g. "sub.confirm"); ' +
  "a checkpoint that declared a 'default' takes it if you resume without one — if the payload carries 'rename_hint', resuming with the SAME node_id only pauses again — rename one of the two checkpoint ids in the spec instead";
export const USER_PAUSE_HINT =
  "you paused this run; nothing will resume it on its own — its " +
  "finished nodes are kept, so run_workflow(resume_run_id=...) " +
  "continues it whenever you want (no budget raise needed)";

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

/** #463: molde `withPivots` — omitted (never a bare `[]`) for a run whose
 * leaves never wrote anything. */
function withArtifacts(
  view: Readonly<Record<string, unknown>>,
  artifacts: readonly RunArtifact[],
): Readonly<Record<string, unknown>> {
  return artifacts.length === 0 ? view : { ...view, artifacts: [...artifacts] };
}

/** Structural, not `DurableRunView` (service.ts) itself — same reasoning as
 * `LiveRunLike` below: importing that type here would make service.ts and
 * service-rollup.ts import each other. Only the fields `pauseFields` reads. */
interface PausedRunLike {
  readonly status: string;
  readonly pause_reason: string | null;
  readonly resume_at: number | null;
  readonly attempts: number;
  readonly checkpoint: Record<string, unknown> | null;
}

/** #427: the fields a `paused` run's reply carries — moved here from
 * service.ts (#463) so its own zero-growth ceiling has room for this
 * issue's new `artifacts` fields; `durableRollup` (service.ts) is still the
 * one caller. */
export function pauseFields(view: PausedRunLike): Readonly<Record<string, unknown>> | null {
  if (view.status !== "paused") return null;
  const fields: Record<string, unknown> = {
    reason: view.pause_reason,
    resume_at: view.resume_at,
    attempts: view.attempts,
  };
  if (view.pause_reason === TOKEN_BUDGET_PAUSE) {
    fields.hint = TOKEN_BUDGET_HINT;
  } else if (view.pause_reason === CHECKPOINT_PAUSE) {
    fields.checkpoint = view.checkpoint;
    fields.hint = CHECKPOINT_HINT;
  } else if (view.pause_reason === USER_PAUSE) {
    fields.hint = USER_PAUSE_HINT;
  } else if (view.pause_reason === ROUTE_FAULT_REASON) fields.lesson = view.checkpoint;
  return Object.freeze(fields);
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
    withArtifacts(
      withPivots(
        {
          run_id: record.id,
          name: record.name,
          status: result.status,
          outputs: structuredClone(result.outputs),
          faults: Object.freeze([
            ...result.faults,
            ...result.sandboxFaults,
            ...result.artifactFaults,
          ]),
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
          // #517 (M16-S2, ADR 0005): always a SUBSET of `usage_uncertain_leaves`
          // above — a leaf whose usage includes an ESTIMATED spend from a
          // call aborted in flight.
          partial_leaves: result.partialLeaves,
          sandbox_refusals: result.sandboxRefusals,
          fault_kinds: [...result.faultKinds],
        },
        record.pivots ?? [],
      ),
      result.artifacts,
    ),
  );
}

/** #460 (M11-S2, épico #458): moved here from `service.ts` (that file's own
 * zero-growth ceiling has no room for this issue's `pivotResume`/
 * `announceRerouted` threading) — a plain, dependency-free pair with nothing
 * to gain from living inside the class file, same move as #246's own
 * `resultView`/`runningView` above. */
export function rawSpecOf(parsed: WorkflowSpec): Record<string, unknown> {
  return {
    meta: { ...parsed.meta },
    inputs: { ...parsed.inputs },
    schemas: { ...parsed.schemas },
    nodes: parsed.nodes.map((node) => ({ id: node.id, type: node.type, ...node.fields })),
  };
}

/** The oracle's None-when-empty rule: a run with no nodes persists no progress. */
export function progressJsonOf(progress: ProgressSnapshot): string | null {
  return progress.total > 0 ? JSON.stringify(progress) : null;
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
