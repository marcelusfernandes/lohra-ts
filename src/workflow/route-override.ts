// Issue #427 (M10-S6, épico #421): a resume's `route` override is a LAYER
// above a node's own resolved routing (`routingOf`, engine-utils.ts) — but
// it's written onto the SPEC's node fields BEFORE the engine ever runs,
// never threaded through `routingOf`/`routingIdentity`'s call sites in
// `engine.ts`/`engine-utils.ts` (zero change to either file, and to the
// `hash-remove-routing` mutation anchor in
// scripts/mutations/workflow-executor-mutants.ts). `routingOf` already
// gives an explicit node.fields.provider/model precedence over the tier
// map — writing the override directly onto those same fields, for every
// node that DECLARES a route (the same four fields `routingIdentity`
// checks), reproduces that precedence rule one layer up, and lets every
// downstream cache-identity function (`routingIdentity`, `loopCellParts`,
// `replayOrCollectBranch`, `recordGroupReplayCost`) re-key itself for free.
// Decision 2 of épico #421 (rota fora da chave para nós sem pino) holds
// automatically: a node that never declared model/tier/effort/provider is
// never touched here either.
import { Node, WorkflowSpec } from "./types.js";
import type { RunResult } from "./accounting.js";

export const MAX_ROUTE_PIVOTS_PER_RUN = 3;

export interface RouteOverride {
  readonly provider?: string;
  readonly model?: string;
}

const ROUTE_FIELDS = ["model", "tier", "effort", "provider"] as const;

/** Same guard `routingIdentity` (engine-utils.ts) uses to decide whether a
 * node's routing enters its cache-cell hash at all — mirrored here (not
 * imported: `routingIdentity` doesn't export the predicate on its own) so a
 * node that declares NONE of the four fields is never touched by a pivot. */
function declaresRoute(fields: Readonly<Record<string, unknown>>): boolean {
  return ROUTE_FIELDS.some((field) => Object.hasOwn(fields, field));
}

/** Only the override's OWN named fields replace the node's — naming just a
 * `model` leaves `provider` exactly as authored (never freezes a
 * tier-derived value onto the node as a literal). */
function overriddenFields(
  fields: Readonly<Record<string, unknown>>,
  override: RouteOverride,
): Record<string, unknown> {
  return {
    ...fields,
    ...(override.provider === undefined ? {} : { provider: override.provider }),
    ...(override.model === undefined ? {} : { model: override.model }),
  };
}

function asStageRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** A `pipeline` stage MAY carry its own `model`/`tier`/`effort`/`provider`,
 * overriding the node's for that stage only (`run_workflow`'s own
 * description, builtin-definitions.ts) — a stage that declares one of its
 * own SHADOWS the node-level pivot below entirely, so it needs the SAME
 * override applied directly, or it keeps refusing on its own old route. */
function overriddenStages(
  stages: readonly unknown[],
  override: RouteOverride,
): readonly unknown[] | null {
  const anyDeclares = stages.some((stage) => {
    const record = asStageRecord(stage);
    return record !== null && declaresRoute(record);
  });
  if (!anyDeclares) return null;
  return stages.map((stage) => {
    const record = asStageRecord(stage);
    return record !== null && declaresRoute(record) ? overriddenFields(record, override) : stage;
  });
}

/** #427: rewrites every node (and pipeline stage) that DECLARES a route —
 * a node with none of the four routing fields is returned unchanged, by
 * reference, so its cache identity (`routingIdentity`) never moves. */
export function overrideNode(node: Node, override: RouteOverride): Node {
  const stages =
    node.type === "pipeline" && Array.isArray(node.fields.stages)
      ? overriddenStages(node.fields.stages, override)
      : null;
  const declares = declaresRoute(node.fields);
  if (!declares && stages === null) return node;
  return new Node(node.id, node.type, {
    ...(declares ? overriddenFields(node.fields, override) : node.fields),
    ...(stages === null ? {} : { stages }),
  });
}

/** #427 AC: `route` on resume applies to every node (and pipeline stage)
 * that declares a route in `spec` — a fresh `WorkflowSpec`, since `Node`
 * and `WorkflowSpec` are both immutable (CLAUDE.md: never mutate shared
 * structures). */
export function applyRouteOverrideToSpec(
  spec: WorkflowSpec,
  override: RouteOverride,
): WorkflowSpec {
  return new WorkflowSpec({
    meta: spec.meta,
    inputs: spec.inputs,
    schemas: spec.schemas,
    nodes: spec.nodes.map((node) => overrideNode(node, override)),
    warnings: spec.warnings,
  });
}

/** Pure merge semantic over an ALREADY-RESOLVED routing triple (`routingOf`,
 * engine-utils.ts) — not on the spec-rewrite path above (that writes
 * straight onto node fields; precedence over the tier map is handled at
 * cache-identity time by `routingOf` itself), but the same "only the
 * override's own named fields win" rule stated once, directly, and
 * exercised on its own. */
export function applyRouteOverride(
  routing: Readonly<{ provider?: string; model?: string; effort?: string }>,
  override: RouteOverride,
): Readonly<{ provider?: string; model?: string; effort?: string }> {
  return {
    ...routing,
    ...(override.provider === undefined ? {} : { provider: override.provider }),
    ...(override.model === undefined ? {} : { model: override.model }),
  };
}

function isRouteOverride(value: unknown): value is RouteOverride {
  if (value === null || typeof value !== "object") return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    (record.provider === undefined || typeof record.provider === "string") &&
    (record.model === undefined || typeof record.model === "string")
  );
}

/** `pause_payload_json.pivots` (service.ts) round-trips through JSON on
 * disk — validated defensively on the way back in, like
 * `prior_fault_kinds` already is (`durableFromRow`, service.ts). */
export function pivotsOf(payload: Readonly<Record<string, unknown>>): readonly RouteOverride[] {
  return Array.isArray(payload.pivots) ? payload.pivots.filter(isRouteOverride) : [];
}

export function nextPivots(
  priorPivots: readonly RouteOverride[],
  override: RouteOverride | undefined,
): readonly RouteOverride[] {
  return override === undefined ? priorPivots : [...priorPivots, override];
}

/** #427 AC: a run pivots route at most `MAX_ROUTE_PIVOTS_PER_RUN` times —
 * decision 4 of épico #421 (a pivot is always a MANUAL resume, never
 * automatic) makes this a de facto human gate past the cap: a named error
 * instead of silently trying yet another route. `options.resumeRunId`
 * absent with an override present is refused here too — tool.ts's own
 * `run_workflow` validation is the primary boundary, but `service.start`
 * is a boundary of its own (CLAUDE.md: validate at every boundary). A
 * plain resume with no `route` at all always passes through untouched. */
export function pivotResume(
  spec: WorkflowSpec,
  options: Readonly<{ resumeRunId?: string; routeOverride?: RouteOverride }>,
  priorPivots: readonly RouteOverride[],
):
  | { readonly ok: true; readonly spec: WorkflowSpec }
  | { readonly ok: false; readonly error: string } {
  const override = options.routeOverride;
  if (override === undefined) return { ok: true, spec };
  if (options.resumeRunId === undefined)
    return { ok: false, error: "'route' is only accepted together with a resume run id" };
  if (priorPivots.length >= MAX_ROUTE_PIVOTS_PER_RUN)
    return {
      ok: false,
      error:
        `workflow run '${options.resumeRunId}' already pivoted route ` +
        `${String(MAX_ROUTE_PIVOTS_PER_RUN)} times — resume without 'route', or fix the ` +
        "underlying auth/model problem instead of trying yet another route",
    };
  return { ok: true, spec: applyRouteOverrideToSpec(spec, override) };
}

/** Structural, not `DurableRunView` (service.ts) itself — importing that
 * type here would make service.ts and route-override.ts import each
 * other; these are the only fields `pausePayloadOf` reads from it. */
interface PriorPauseView {
  readonly leaf_respawns: number;
  readonly sandbox_refusals: number;
  readonly prior_fault_kinds: readonly string[];
  readonly prior_degraded: boolean;
  readonly pivots: readonly RouteOverride[];
}

/** #427: pulled the whole `pause_payload_json` JSON shape out of
 * `service.ts`'s `launchDurable` (it was `priorFaults`/`priorDegraded`
 * plus this closure, together bigger than the `pivots` field this issue
 * adds) so the new field fits inside service.ts's own zero-growth ceiling
 * (issue #427). Same shape as before; `pivots` is OMITTED (never written
 * as an empty array) for a run that never pivoted, so a run that predates
 * this issue keeps a byte-identical payload. */
export function pausePayloadOf(
  attempt: number,
  priorView: PriorPauseView | null,
  carriedFaults: readonly string[],
  result: RunResult,
  options: Readonly<{ routeOverride?: RouteOverride }>,
): (checkpoint: unknown, resumeAt: number | null) => string {
  const faults = [...carriedFaults, ...result.faults, ...result.sandboxFaults];
  const degraded =
    priorView?.prior_degraded === true ||
    result.faults.some((fault) => fault !== result.pauseFault);
  const pivots = nextPivots(priorView?.pivots ?? [], options.routeOverride);
  return (checkpoint, resumeAt) =>
    JSON.stringify({
      checkpoint,
      resume_at: resumeAt,
      attempts: attempt,
      leaf_respawns: (priorView?.leaf_respawns ?? 0) + result.leafRespawns,
      sandbox_refusals: (priorView?.sandbox_refusals ?? 0) + result.sandboxRefusals,
      prior_faults: faults,
      prior_fault_kinds: [...(priorView?.prior_fault_kinds ?? []), ...result.faultKinds],
      prior_degraded: degraded,
      ...(pivots.length === 0 ? {} : { pivots }),
    });
}
