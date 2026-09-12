import type { RunControl, WorkflowEngineOptions, WorkflowLoader } from "./engine-contract.js";
import type { ChildRuntime } from "./runtime.js";
import type { RouteOverride } from "./route-override.js";
import type { TierMap } from "./tiers.js";

/**
 * Shared shape of `WorkflowService.start`'s options bag and the durable
 * launch/resume path's internal one — checkpoint answers, an optional token
 * budget cap, and the run id to resume, if any. One definition instead of
 * three near-identical inline object types across `service.ts` (#258).
 */
export interface WorkflowLaunchOptions {
  readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
  readonly tokenBudget?: number | null;
  readonly resumeRunId?: string;
  /** #427: only meaningful together with `resumeRunId` — `pivotResume`
   * (route-override.ts) refuses it otherwise. */
  readonly routeOverride?: RouteOverride;
}

/** `WorkflowLaunchOptions` plus the operator tier map resolved once per
 * `start()` call, threaded to whichever launch path (fresh or durable)
 * actually constructs the `WorkflowEngine` (#258). */
export interface WorkflowLaunchOptionsWithTiers extends WorkflowLaunchOptions {
  readonly tiers: TierMap;
}

/**
 * The `WorkflowEngine` fields that never differ in KIND between the two
 * construction sites in `WorkflowService` (fresh launch, durable
 * launch/resume) — runtime, run id, the operator tier map, and the two
 * caller-optional fields that `exactOptionalPropertyTypes` requires be
 * OMITTED rather than set to `undefined`. Each site still supplies its own
 * `budget`, `cache` and `onEvent` — those genuinely diverge (in-memory vs
 * SQLite-backed cache; forwarding vs lease-renewing `onEvent`).
 */
export function engineBaseOptions(
  runtime: ChildRuntime,
  runId: string,
  tiers: TierMap,
  loader: WorkflowLoader | undefined,
  checkpointAnswers: Readonly<Record<string, unknown>>,
  /** #452: threaded so a resume's `route` reaches `runNested`'s freshly
   * loaded template too — omitted here (as of this issue) at both
   * `WorkflowService` construction sites, tracked on #452. */
  routeOverride?: RouteOverride,
): Pick<
  WorkflowEngineOptions,
  "runtime" | "runId" | "tiers" | "loader" | "checkpointAnswers" | "routeOverride"
> {
  return {
    runtime,
    runId,
    tiers,
    ...(loader === undefined ? {} : { loader }),
    ...(Object.keys(checkpointAnswers).length > 0 ? { checkpointAnswers } : {}),
    ...(routeOverride === undefined ? {} : { routeOverride }),
  };
}

/** #452: `WorkflowEngine`'s default `RunControl` (constructor, engine.ts) —
 * pulled out so that zero-growth file keeps a one-line assignment instead of
 * inlining the same idle shape at its one call site. */
export function idleRunControl(): RunControl {
  return { cancelled: false, paused: false, pauseReason: null, pausePayload: null };
}
