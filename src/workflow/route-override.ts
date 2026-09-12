// Issue #427 (M10-S6, épico #421): a resume's `route` override is a LAYER
// above a node's own resolved routing (`routingOf`, engine-utils.ts) — but
// it's written onto the SPEC's node fields BEFORE the engine ever runs,
// never threaded through `routingOf`/`routingIdentity`'s call sites in
// `engine.ts`/`engine-utils.ts` (no change to `routingOf`/`routingIdentity`
// themselves, nor to the `hash-remove-routing` mutation anchor in
// scripts/mutations/workflow-executor-mutants.ts — #452's `overrideNestedSpec`
// below reuses this same rewrite for a template `runNested` only sees at
// runtime, and costs `engine.ts` one swapped call, net zero lines). `routingOf` already
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
import {
  dedupeArtifactFaultsByPath,
  recordCrossStretchArtifactCollisions,
  type RunArtifact,
  type RunResult,
} from "./accounting.js";
import { routingOf } from "./engine-utils.js";
import { isRouteLesson, ROUTE_FAULT_REASON } from "./route-faults.js";
import type { TierMap } from "./tiers.js";

export const MAX_ROUTE_PIVOTS_PER_RUN = 3;

/** #460 (M11-S2, épico #458): `operator` for an explicit `route`
 * (`run_workflow`'s own argument); `route_envelope` for the operator's own
 * `workflow_routes.json` suggestion (`suggested_route`, #459) applied
 * automatically on a route-less resume — decision 1(b), épico #458. */
export type RouteChannel = "operator" | "route_envelope";

export interface RouteOverride {
  readonly provider?: string;
  readonly model?: string;
  /** Absent on a pivot recorded before this issue — round-trips through
   * `pause_payload_json` like `provider`/`model` above (`pivotsOf`). */
  readonly channel?: RouteChannel;
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

/** #452: `runNested` (engine.ts) only sees a `workflow` node's `ref`
 * template AFTER `this.loader` resolves it at runtime — #427's
 * `pivotResume` already ran (and can only run) on the OUTER spec, before
 * the engine starts, so a resumed run's pivot never reached a template
 * loaded by reference. Same rewrite as `applyRouteOverrideToSpec`, called
 * from `runNested` with the root engine's OWN `routeOverride` instead —
 * `undefined` (a plain resume, or depth already > 0 where nothing is
 * threaded, since `MAX_WORKFLOW_DEPTH` never lets a nested engine load
 * ANOTHER template of its own) returns `spec` unchanged, by reference, so a
 * template that never declares a route is never rebuilt. */
export function overrideNestedSpec(
  spec: WorkflowSpec,
  routeOverride: RouteOverride | undefined,
): WorkflowSpec {
  return routeOverride === undefined ? spec : applyRouteOverrideToSpec(spec, routeOverride);
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
    (record.model === undefined || typeof record.model === "string") &&
    (record.channel === undefined ||
      record.channel === "operator" ||
      record.channel === "route_envelope")
  );
}

/** `pause_payload_json.pivots` (service.ts) round-trips through JSON on
 * disk — validated defensively on the way back in, like
 * `prior_fault_kinds` already is (`durableFromRow`, service.ts). */
export function pivotsOf(payload: Readonly<Record<string, unknown>>): readonly RouteOverride[] {
  return Array.isArray(payload.pivots) ? payload.pivots.filter(isRouteOverride) : [];
}

function isRunArtifact(value: unknown): value is RunArtifact {
  if (value === null || typeof value !== "object") return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.node_id === "string" &&
    typeof record.sub_id === "string" &&
    typeof record.path === "string" &&
    typeof record.bytes === "number" &&
    Number.isFinite(record.bytes)
  );
}

/** `pause_payload_json.artifacts` (service.ts) round-trips through JSON on
 * disk — validated defensively on the way back in, molde `pivotsOf` (#463). */
export function artifactsOf(payload: Readonly<Record<string, unknown>>): readonly RunArtifact[] {
  return Array.isArray(payload.artifacts) ? payload.artifacts.filter(isRunArtifact) : [];
}

export function nextPivots(
  priorPivots: readonly RouteOverride[],
  override: RouteOverride | undefined,
): readonly RouteOverride[] {
  return override === undefined ? priorPivots : [...priorPivots, override];
}

/** #460 (M11-S2): one `node.rerouted` candidate — `node_id` is the node's
 * own id (a pipeline stage's rewrite is attributed to its PARENT node, never
 * a stage sub-id: `overrideNode` above rewrites the whole node when ANY
 * stage declares a route); `from`/`to` are the node's own RESOLVED routing
 * (`routingOf`, engine-utils.ts) before/after the rewrite, so a node that
 * only names a `tier` still reports the actual provider/model it was going
 * to run on, not just its raw fields. A pipeline node whose route lives only
 * on a stage (never the node's own fields) still gets exactly one record
 * here — `from`/`to` in that case mirror the node's OWN (stage-blind)
 * routing, since the engine resolves each stage's routing independently at
 * runtime (`runPipeline`, engine.ts) and this issue doesn't thread that far. */
export interface RerouteRecord {
  readonly node_id: string;
  readonly from: Readonly<{ provider?: string; model?: string }>;
  readonly to: Readonly<{ provider?: string; model?: string }>;
}

function routingPair(node: Node, tiers: TierMap): Readonly<{ provider?: string; model?: string }> {
  const routing = routingOf(node, tiers);
  return {
    ...(routing.provider === undefined ? {} : { provider: routing.provider }),
    ...(routing.model === undefined ? {} : { model: routing.model }),
  };
}

/** One record per node `overrideNode` actually rewrote — reference
 * inequality, the same signal `applyRouteOverrideToSpec`'s own per-node map
 * already produces for free. `before`/`after` share the same node order (one
 * spec rewritten from the other), so a plain index pairing is enough. */
function rerouteRecords(
  before: WorkflowSpec,
  after: WorkflowSpec,
  tiers: TierMap,
): readonly RerouteRecord[] {
  const records: RerouteRecord[] = [];
  for (let index = 0; index < before.nodes.length; index += 1) {
    const beforeNode = before.nodes[index];
    const afterNode = after.nodes[index];
    if (beforeNode === undefined || afterNode === undefined || beforeNode === afterNode) continue;
    records.push({
      node_id: beforeNode.id,
      from: routingPair(beforeNode, tiers),
      to: routingPair(afterNode, tiers),
    });
  }
  return records;
}

/** #460: the prior stretch's own pause state — only what `pivotResume`
 * needs to decide whether a route-less resume should apply the operator's
 * route envelope (S1, `suggested_route`). `null` for a fresh launch, or any
 * resume whose durable view this service never loaded. Structural, not
 * `DurableRunView` (service.ts) itself — same reasoning as `PriorPauseView`
 * below (importing that type here would make service.ts and
 * route-override.ts import each other). */
export interface PivotResumePrior {
  readonly pivots: readonly RouteOverride[];
  readonly pauseReason: string | null;
  readonly checkpoint: unknown;
}

export type PivotResumeResult =
  | {
      readonly ok: true;
      readonly spec: WorkflowSpec;
      readonly override?: RouteOverride;
      readonly rerouted: readonly RerouteRecord[];
    }
  | { readonly ok: false; readonly error: string };

/** #427 AC: a run pivots route at most `MAX_ROUTE_PIVOTS_PER_RUN` times —
 * decision 4 of épico #421 (a pivot is always a MANUAL resume, never
 * automatic) makes this a de facto human gate past the cap: a named error
 * instead of silently trying yet another route. `options.resumeRunId`
 * absent with an override present is refused here too — tool.ts's own
 * `run_workflow` validation is the primary boundary, but `service.start`
 * is a boundary of its own (CLAUDE.md: validate at every boundary).
 *
 * #460 (M11-S2, épico #458, decision 1(b)): an explicit `route` always wins
 * (channel `operator`) — unchanged from #427 above, just tagged. A
 * route-less resume of a run paused `route_fault` (`prior.pauseReason`)
 * whose lesson (`isRouteLesson`) carries a non-null `suggested_route`
 * applies it automatically (channel `route_envelope`), subject to the SAME
 * shared cap — but AT the cap, a route-less resume is never refused (the
 * operator never asked for a pivot; refusing would block a legitimate plain
 * resume): it just stays on the current route, spending no pivot and
 * rewriting no node (`rerouted: []`). Only an EXPLICIT `route` at the cap is
 * refused, same named error as before. */
export function pivotResume(
  spec: WorkflowSpec,
  options: Readonly<{ resumeRunId?: string; routeOverride?: RouteOverride; tiers: TierMap }>,
  prior: PivotResumePrior | null,
): PivotResumeResult {
  const priorPivots = prior?.pivots ?? [];
  const explicit = options.routeOverride;
  if (explicit !== undefined) {
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
    const override: RouteOverride = { ...explicit, channel: "operator" };
    const rewritten = applyRouteOverrideToSpec(spec, override);
    return {
      ok: true,
      spec: rewritten,
      override,
      rerouted: rerouteRecords(spec, rewritten, options.tiers),
    };
  }
  if (
    prior !== null &&
    prior.pauseReason === ROUTE_FAULT_REASON &&
    isRouteLesson(prior.checkpoint) &&
    prior.checkpoint.suggested_route !== null &&
    priorPivots.length < MAX_ROUTE_PIVOTS_PER_RUN
  ) {
    const override: RouteOverride = {
      ...prior.checkpoint.suggested_route,
      channel: "route_envelope",
    };
    const rewritten = applyRouteOverrideToSpec(spec, override);
    return {
      ok: true,
      spec: rewritten,
      override,
      rerouted: rerouteRecords(spec, rewritten, options.tiers),
    };
  }
  return { ok: true, spec, rerouted: [] };
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
  /** #463: past write-file manifest/collision faults, folded forward the
   * same way `pivots` above is. */
  readonly artifacts: readonly RunArtifact[];
  readonly artifact_faults: readonly string[];
}

/** #446: `persistLine` (service.ts) has TWO callers that used to hardcode
 * `pausePayloadJson: null` — the stretch's own registration write and the
 * per-node progress write (#125) — so a process that crashed anywhere
 * between either of those and the terminal write (`pausePayloadOf` below)
 * reset `pivots` to empty on the next read: the de facto human gate of
 * `MAX_ROUTE_PIVOTS_PER_RUN` was contournable by an ordinary crash. This
 * carries `pivots` forward onto both `null` callers instead, computed the
 * SAME way the terminal write folds it (`nextPivots`), and writes nothing
 * else — `prior_*`/`checkpoint`/`resume_at` still only land at the
 * terminal write. A run that never pivoted keeps writing a literal `null`
 * (`nextPivots` returns the same empty array back), byte-identical to
 * before this issue. */
export function registrationPayload(
  priorView: PriorPauseView | null,
  options: Readonly<{ routeOverride?: RouteOverride }>,
): string | null {
  const pivots = nextPivots(priorView?.pivots ?? [], options.routeOverride);
  return pivots.length === 0 ? null : JSON.stringify({ pivots });
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
  // #485: a stretch boundary is the one place `recordLeafSideChannels`
  // (accounting.ts) never sees — its own `result.artifacts` starts empty on
  // every resume — so the cross-stretch check runs here, once, before the
  // fold below reads `result.artifactFaults`.
  recordCrossStretchArtifactCollisions(result, priorView?.artifacts ?? []);
  const artifacts = [...(priorView?.artifacts ?? []), ...result.artifacts];
  // #512: deduped BEFORE persisting (not just on the live read,
  // `foldArtifactFaults`/service.ts) — a path already flagged in an earlier
  // stretch's own persisted `artifact_faults` never gets written twice into
  // this stretch's terminal payload, so a cold read (`durableRollup`) of a
  // dormant run agrees with the live one instead of accumulating one more
  // duplicate advisory per resume.
  const artifactFaults = dedupeArtifactFaultsByPath([
    ...(priorView?.artifact_faults ?? []),
    ...result.artifactFaults,
  ]);
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
      ...(artifacts.length === 0 ? {} : { artifacts }),
      ...(artifactFaults.length === 0 ? {} : { artifact_faults: artifactFaults }),
    });
}
