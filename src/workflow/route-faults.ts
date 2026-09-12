// Issue #426 (M10-S5, épico #421): a leaf refused by the PROVIDER's own
// routing (`auth_failed`/`route_fault`/`model_not_found`,
// `src/transports/error-kinds.ts`) is not the same failure as bad content —
// retrying the SAME route never recovers it, so it pauses the run with a
// structured lesson instead of degrading into `faults` like any other kind.
// `quota_exhausted` already had its own branch in
// `nonCompleteFirstCollectResult` (`engine-utils.ts`); this sibling module
// holds the route-specific half so that file's line budget stays flat
// (issue's own ceilings: `engine-utils.ts` ≤ 800, `engine.ts` ≤ 980,
// `service.ts` ≤ 1296 — all already at cap before this issue).
//
// Decision 4 (épico #421, comment on issue #421): pivoting to a different
// route is a MANUAL resume (`run_workflow(resume_run_id, route: {...})`,
// S6) — `suggested_route` is always `null` here; no billing-route resolver
// is wired into the engine by this issue, so "unknown route" and "pivot
// requires a human" are the same state.
import { deriveStatus, type RunResult } from "./accounting.js";
import { QUOTA_EXHAUSTED, type RunControl } from "./engine-contract.js";
import type { NoticesSinkRepository } from "./notices-sink.js";
import type { ChildResult } from "./runtime.js";
import type { Routing } from "./engine-utils.js";
import type { ErrorKind } from "../transports/error-kinds.js";
import type { Ownership } from "../state/workflow-repository.js";

/** `WorkflowEngine.pause`'s 5th reason (`audit-model.ts`'s `reason`
 * allow-list tracked "exactly four" before this — `checkpoint`,
 * `quota_exhausted`, `token_budget_exhausted`, `user_requested`). */
export const ROUTE_FAULT_REASON = "route_fault";

const ROUTE_FAULT_KINDS: ReadonlySet<string> = new Set([
  "auth_failed",
  "route_fault",
  "model_not_found",
]);

/** `true` for the three kinds this issue pauses on — never `quota_exhausted`
 * (that kind keeps its own pre-existing branch). */
export function isRouteFault(kind: ErrorKind | null | undefined): boolean {
  return kind !== null && kind !== undefined && ROUTE_FAULT_KINDS.has(kind);
}

/** Generalizes the "this pauses the run, so it's never the LEAF's own fault
 * kind" rule `engine-utils.ts:490` already applied to `quota_exhausted`
 * alone (emenda do orquestrador 2026-09-12, issue #426): a leaf whose kind
 * pauses the run gets RE-EXECUTED on resume, so counting it in
 * `faultKinds`/`fault_kinds_total` now would double it later — same reason
 * quota was already excluded. */
export function pausesRun(kind: ErrorKind | null | undefined): boolean {
  return kind === QUOTA_EXHAUSTED || isRouteFault(kind);
}

/** The structured lesson `pause_payload_json` carries for a route fault
 * (issue #426 AC1) — `suggested_route` stays `null` (decision 4 above). */
export interface RouteLesson {
  readonly error_kind: ErrorKind;
  readonly node_id: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly suggested_route: null;
}

export function routeLesson(collected: ChildResult, nodeId: string, routing: Routing): RouteLesson {
  return Object.freeze({
    error_kind: collected.errorKind as ErrorKind,
    node_id: nodeId,
    provider: collected.provider ?? routing.provider ?? null,
    model: collected.model ?? routing.model ?? null,
    suggested_route: null,
  });
}

/** What `WorkflowService` hands the notices repository at `run:<runId>`
 * when a route fault pauses a durable run — `kind` is the vocabulary value
 * itself (already in `NOTICE_KINDS`, `src/state/notices-repository.ts`),
 * never reclassified through `notices-sink.ts`'s substring `classify()`. */
export function routeFaultNotice(lesson: RouteLesson): Readonly<{ kind: string; message: string }> {
  return Object.freeze({
    kind: lesson.error_kind,
    message:
      `${lesson.node_id}: route fault (${lesson.error_kind}) — ` +
      `provider=${lesson.provider ?? "unknown"} model=${lesson.model ?? "unknown"}; ` +
      `resume with run_workflow(resume_run_id=..., route={...}) once you pick a different one`,
  });
}

/** Narrows `result.checkpoint` (typed `unknown` on `RunResult`, shared by
 * every pause reason) to a `RouteLesson` — the shape `routeLesson()` above
 * always freezes it into, never trusted by cast alone (issue #426, 3ª
 * emenda: the revisor flagged `as unknown as RouteLesson` as a checkpoint
 * from some OTHER pause reason would throw inside `service.ts`'s terminal
 * `.then`, never reaching this function at all in practice — this guard
 * is the belt for that suspenders). */
export function isRouteLesson(value: unknown): value is RouteLesson {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    typeof candidate.error_kind === "string" &&
    isRouteFault(candidate.error_kind as ErrorKind) &&
    typeof candidate.node_id === "string" &&
    (candidate.provider === null || typeof candidate.provider === "string") &&
    (candidate.model === null || typeof candidate.model === "string") &&
    candidate.suggested_route === null
  );
}

/** `appendSafe`'s result — distinguishes the repository plainly REFUSING the
 * write (`.append` returned `null`, `cause: null`) from `.append` itself
 * THROWING (an unexpected repository failure, `cause: String(error)`), so
 * `recordRouteFaultNotice` below can put the cause in the `warn` instead of
 * discarding it (issue #449; the two used to collapse into one `boolean`,
 * and a thrown repository error vanished from the diagnostic). */
type AppendOutcome =
  { readonly recorded: true } | { readonly recorded: false; readonly cause: string | null };

/** Never throws — `.append` itself refusing (returns `null`) and `.append`
 * THROWING (an unexpected repository failure) both resolve to a
 * `recorded: false` outcome for the caller below, which runs inside
 * `service.ts`'s terminal `.then` (an uncaught throw there would be a
 * silent-crash surface, not a fault) — but the THROWN case carries its
 * `cause` (issue #449) instead of discarding it like the refusal does. */
function appendSafe(
  repository: NoticesSinkRepository | undefined,
  runId: string,
  notice: Readonly<{ kind: string; message: string }>,
  ownership: Ownership | null,
): AppendOutcome {
  try {
    const written = repository?.append(`run:${runId}`, notice, ownership ?? undefined) ?? null;
    return written !== null ? { recorded: true } : { recorded: false, cause: null };
  } catch (error) {
    return { recorded: false, cause: String(error) };
  }
}

/** Issue #426: writes a route fault's lesson as a durable notice at `run:<runId>` — `kind` is the vocabulary value itself, never reclassified. Falls back to `warn` (never silent, invariant 2) when no repository is wired yet, the checkpoint isn't actually a lesson, or `appendSafe` above reports the write didn't land — carrying the cause (issue #449, `String(error)`) when it didn't land because `.append` THREW, as opposed to plainly refusing. */
export function recordRouteFaultNotice(
  repository: NoticesSinkRepository | undefined,
  runId: string,
  checkpoint: Readonly<Record<string, unknown>> | null,
  ownership: Ownership | null,
  warn: (message: string) => void,
): void {
  if (!isRouteLesson(checkpoint)) {
    warn(`workflow: route fault notice for run ${runId} had no lesson to record`);
    return;
  }
  const notice = routeFaultNotice(checkpoint);
  const outcome = appendSafe(repository, runId, notice, ownership);
  if (!outcome.recorded) {
    const detail = outcome.cause === null ? "the write was refused" : `it threw: ${outcome.cause}`;
    warn(`workflow: route fault notice for run ${runId} could not be recorded durably (${detail})`);
  }
}

/** Pulled out of `engine.ts`'s `run()` tail (#426, same "make room" move as #329/#336/#348 in `engine-utils.ts`) — seals `result.status`/`pauseReason`/`checkpoint` from `control` once every node has settled. `checkpoint` carries whatever payload `pause()` set — a `RouteLesson` for a route fault, same transport any other pause reason already uses. */
export function sealRunStatus(result: RunResult, control: RunControl): void {
  if (control.cancelled) {
    result.status = "cancelled";
  } else if (control.paused) {
    result.status = "paused";
    result.pauseReason = control.pauseReason;
    result.checkpoint = control.pausePayload;
  } else if (result.status !== "failed") {
    result.status = deriveStatus(result);
  }
}
