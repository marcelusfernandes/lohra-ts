import type { RunControl, WorkflowEngineOptions, WorkflowLoader } from "./engine-contract.js";
import type { ChildRuntime } from "./runtime.js";
import type { RerouteRecord, RouteOverride } from "./route-override.js";
import type { RouteEnvelope } from "./routes.js";
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

/** `WorkflowLaunchOptions` plus the operator tier map and the operator's
 * route-fallback envelope (#459), both resolved once per `start()` call,
 * threaded to whichever launch path (fresh or durable) actually constructs
 * the `WorkflowEngine` (#258) — `routes` never reaches the engine itself
 * (it isn't an `WorkflowEngineOptions` field); the terminal reads it
 * straight off `options` to call `withSuggestedRoute`. */
export interface WorkflowLaunchOptionsWithTiers extends WorkflowLaunchOptions {
  readonly tiers: TierMap;
  readonly routes: RouteEnvelope;
  /** #460 (M11-S2): the nodes `pivotResume` (route-override.ts) actually
   * rewrote THIS call — never persisted (`pause_payload_json`'s own
   * `pivots` already carries the applied override); `service.ts`'s
   * `launchDurable` reads it once, to call `announceRerouted`. */
  readonly rerouted?: readonly RerouteRecord[];
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
): Pick<WorkflowEngineOptions, "runtime" | "runId" | "tiers" | "loader" | "checkpointAnswers"> {
  return {
    runtime,
    runId,
    tiers,
    ...(loader === undefined ? {} : { loader }),
    ...(Object.keys(checkpointAnswers).length > 0 ? { checkpointAnswers } : {}),
  };
}

/** #452 (rodada 2, PR #472): a `routeOverride` spread, factored out so both
 * `WorkflowEngine` construction sites in `service.ts` (`launch`,
 * `launchDurable`) apply the SAME rule — NOT folded into
 * `engineBaseOptions` itself, because the durable site's own
 * `engineBaseOptions(...)` call is a mutation anchor
 * (`scripts/mutations/workflow-durability-named.ts`, `ao/durable-…-tier-map`)
 * whose literal text a 6th argument would change. `exactOptionalPropertyTypes`
 * is why this can't be `{ routeOverride: routeOverride }` directly. */
export function routeOverrideOption(
  routeOverride: RouteOverride | undefined,
): Pick<WorkflowEngineOptions, "routeOverride"> | Record<string, never> {
  return routeOverride === undefined ? {} : { routeOverride };
}

/** #452: `WorkflowEngine`'s default `RunControl` (constructor, engine.ts) —
 * pulled out so that zero-growth file keeps a one-line assignment instead of
 * inlining the same idle shape at its one call site. */
export function idleRunControl(): RunControl {
  return { cancelled: false, paused: false, pauseReason: null, pausePayload: null };
}
