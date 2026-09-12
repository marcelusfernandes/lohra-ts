// Issue #462 (M11-S4, épico #458): `workflow_preview {run_id, route?}` — a
// dry-run of `run_workflow(resume_run_id, ...)` that answers "what would
// replay, what would recompute, and why" WITHOUT spending a token, without
// writing a single row, and without consuming one of the run's
// `MAX_ROUTE_PIVOTS_PER_RUN` pivots when `route` is given (decision 5,
// épico #458 map: a tool of its own, not a `run_workflow` flag — reading
// must never travel on the launch tool).
//
// Zero hash duplication: the real `WorkflowEngine` (`engine.ts`) computes
// every cell's `content_hash` itself, exactly as a real resume would — this
// module never re-derives `cell()`/`routingIdentity`/`loopCellParts`/etc.
// Instead it hands the engine (a) a DRY `ChildRuntime` whose `spawn` just
// records `{nodePath, cellId}` from the real `causalContext` and returns an
// id, and whose `collect` always reports a generic `"failed"` leaf — never
// a quota/route error kind, so a preview run never PAUSES on a fault a real
// resume hasn't hit yet — and (b) a READ-ONLY facade over the run's real
// `SqliteWorkflowCache`: `get` passes straight through (an honest lookup
// against the real database) and records the hit's owner for attribution;
// `put` is a hard no-op (`false`, never touches the database, never calls
// `onWrite`) — NOT belt-and-suspenders, load-bearing: a `parallel` node
// whose `branches` resolves to `[]` calls `cache.put(...)` unconditionally
// (`engine.ts`'s `runParallel`, `[].every(nonEmpty)` is vacuously `true`)
// without spawning a single leaf, dry or real. TWO independent barriers
// stop that call from landing a row: `put`'s own `return false` here, and
// (below, `previewResume`) the guarded `SqliteWorkflowCache` it wraps is
// built with a `dummyOwnership` of `fence: -1` — `workflow-repository.ts`'s
// `ownershipGuard` requires an exact fence match, so even a mutated `put`
// that DID delegate to the real cache would have its guarded `INSERT`
// refused (`cell.changes === 0`) by that second barrier. P6
// (`supervision-mutants.ts`) targets the FIRST barrier — a mutant that
// removes it must still be observable, so its oracle
// (`tests/workflow-cache-preview-writes.test.ts`) counts attempts at
// `WorkflowRepository.putCacheCellWithCost` (the call the facade's `put`
// would otherwise never make), not just the row count the fence guard
// would zero out either way.
//
// Attribution: a cell's owner (the `nodeId` `cacheGet`/`cachePut` pass) and
// a spawn's `causalContext.nodePath` are both scoped by `scopedCheckpointId`
// (`engine-utils.ts`) — `<workflowNodeId>.<innerNodeId>` for anything inside
// a nested `workflow` node (`MAX_WORKFLOW_DEPTH` bounds nesting to one
// level). Splitting on the first `.` segment attributes every hit/spawn,
// nested or not, to the TOP-level spec node that owns it — the same rule
// the épico's map states for both channels.
import type Database from "better-sqlite3";
import { join } from "node:path";

import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import { LockRepository } from "../state/locks.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import type { CacheLookup, WorkflowCache, WorkflowCacheOwnership } from "./cache.js";
import { Budget } from "./budget.js";
import { SqliteWorkflowCache } from "./sqlite-cache.js";
import type { WorkflowLoader } from "./engine-contract.js";
import { engineBaseOptions, idleRunControl, routeOverrideOption } from "./engine-options.js";
import { WorkflowEngine } from "./engine.js";
import { topologicalOrder } from "./graph.js";
import { applyRouteOverrideToSpec, type RouteOverride } from "./route-override.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
} from "./runtime.js";
import { OPERATOR_TIERS_FILE, readTiers, TiersError, type TierMap } from "./tiers.js";
import {
  busyErrorMessage,
  CHECKPOINT_PAUSE,
  durableFromRow,
  TOKEN_BUDGET_PAUSE,
} from "./service.js";
import { validateSpec } from "./schema.js";
import { isValidationError, type Node, type WorkflowSpec } from "./types.js";

export interface PreviewDeps {
  readonly database: Database.Database;
  readonly repository: WorkflowRepository;
  readonly locks: LockRepository;
  readonly tiers: TierMap;
  readonly loader?: WorkflowLoader;
  readonly runId: string;
  readonly route?: RouteOverride;
  /** Seconds since epoch — same clock unit `productionOwnershipStore`/`LockRepository.runLeaseExpiry` use. */
  readonly now: number;
}

export type PreviewOutcome =
  | "replay"
  | "recompute"
  | "checkpoint_pending"
  | "upstream_missing"
  | "token_budget_exhausted"
  | "nested"
  | "unknown";

export interface PreviewNodeOutcome {
  readonly node_id: string;
  readonly type: string;
  readonly outcome: PreviewOutcome;
  /** Only present when `outcome === "recompute"`. */
  readonly reason?: "never_completed" | "identity_changed";
  /** Only present when `outcome === "nested"` (a `workflow` node whose nested engine actually ran). */
  readonly cells_replayed?: number;
  readonly cells_to_recompute?: number;
  readonly leaves_to_spawn?: number;
}

export interface PreviewResult {
  readonly run_id: string;
  readonly route_applied: boolean;
  readonly pivots_used: number;
  readonly nodes: readonly PreviewNodeOutcome[];
  readonly cells_replayed: number;
  readonly tokens_saved: number;
  readonly leaves_to_spawn: number;
  readonly estimated_tokens_to_repay: number | null;
  readonly estimate_basis: "measured_average" | null;
  /** Observability only — an engine fault (e.g. a `workflow` node with no
   * loader) never blocks the preview; it surfaces as `outcome: "unknown"`
   * on that node AND is counted here. */
  readonly engine_faults: number;
}

export interface PreviewError {
  readonly error: string;
}

/** One spawn the dry runtime recorded — never a real leaf, never charged. */
interface RecordedSpawn {
  readonly nodePath: readonly string[];
  readonly cellId: string;
}

/** #462: never asks a provider, never times out — every spawn resolves to a
 * generic dead leaf on its very next `collect()` call. Deliberately NOT a
 * quota/route error kind: a preview must never PAUSE the way a real resume
 * might (`nonCompleteFirstCollectResult`, engine-utils.ts, only pauses on
 * `QUOTA_EXHAUSTED` or a route-fault kind) — it only ever records a plain
 * fault and lets the run keep going, node by node. */
class DryRuntime implements ChildRuntime {
  readonly spawns: RecordedSpawn[] = [];
  private seq = 0;

  spawn(request: ChildSpawnRequest): string {
    this.seq += 1;
    this.spawns.push({
      nodePath: request.causalContext.nodePath,
      cellId: request.causalContext.cellId,
    });
    return `preview-leaf-${String(this.seq)}`;
  }

  collect(_id: string, _options: ChildCollectOptions): ChildResult {
    return { status: "failed", output: "preview: would spawn" };
  }

  steer(): void {
    // never reached — a dry leaf never lives long enough to be steered.
  }

  cancel(): void {
    // never reached — a dry leaf is never left "running".
  }
}

interface OwnerTotals {
  count: number;
  tokensSaved: number;
}

interface OwnerSpawns {
  count: number;
  readonly cellIds: Set<string>;
}

type MissReason = "never_completed" | "identity_changed";

function tokensOf(cost: CacheLookup["cost"]): number {
  return cost === null ? 0 : cost.inputTokens + cost.outputTokens;
}

function firstSegment(scoped: string): string {
  return scoped.split(".")[0] ?? scoped;
}

/** Read-only over a real `SqliteWorkflowCache`: `get` is an honest pass-through
 * (recording the hit's owner for attribution, and — issue #484 — a MISS's
 * own `CacheLookup.miss` reason, straight from `SqliteWorkflowCache.lookup`
 * (#461): never a second, duplicated SQL query against
 * `workflow_node_cache`), `put` never touches the database — no
 * `producers.wrapCache`, so this never emits a `cache.*` ledger event
 * either (the épico's own "zero escrita" requirement). */
class PreviewCacheFacade implements WorkflowCache {
  totalHits = 0;
  totalTokensSaved = 0;
  readonly hitsByOwner = new Map<string, OwnerTotals>();
  readonly missReasonByOwner = new Map<string, MissReason>();

  constructor(private readonly real: WorkflowCache) {}

  get(runId: string, hash: string, nodeId?: string): CacheLookup {
    const found = this.real.get(runId, hash, nodeId);
    if (found.hit) {
      const tokens = tokensOf(found.cost);
      this.totalHits += 1;
      this.totalTokensSaved += tokens;
      if (nodeId !== undefined) {
        const owner = firstSegment(nodeId);
        const bucket = this.hitsByOwner.get(owner) ?? { count: 0, tokensSaved: 0 };
        bucket.count += 1;
        bucket.tokensSaved += tokens;
        this.hitsByOwner.set(owner, bucket);
      }
    } else if (nodeId !== undefined && found.miss !== undefined) {
      this.missReasonByOwner.set(firstSegment(nodeId), found.miss);
    }
    return found;
  }

  put(): boolean {
    return false;
  }

  totalCost(runId: string): Readonly<{ inputTokens: number; outputTokens: number }> {
    return this.real.totalCost(runId);
  }

  totalSplit(runId: string) {
    return this.real.totalSplit(runId);
  }
}

/** Mirrors `WorkflowService.seedSpend` (service.ts, out of this issue's
 * Files, private) — the SAME "whichever total is bigger" rule, so a preview
 * gates `token_budget_exhausted` at the same threshold a real resume would.
 * Duplicated rather than imported: `seedSpend` is a private method, and
 * `service.ts` must grow zero lines for this issue (AC). */
function seedSpend(
  repository: WorkflowRepository,
  runId: string,
): Readonly<{ tokensIn: number; tokensOut: number }> {
  const fromRow = repository.getRunSpend(runId);
  const fromCells = repository.cacheCostTotals(runId);
  const rowIn = Number(fromRow?.tokens_in ?? 0);
  const rowOut = Number(fromRow?.tokens_out ?? 0);
  const useRow = rowIn + rowOut >= fromCells.tokensIn + fromCells.tokensOut;
  return useRow
    ? { tokensIn: rowIn, tokensOut: rowOut }
    : { tokensIn: fromCells.tokensIn, tokensOut: fromCells.tokensOut };
}

/** The run's own measured average tokens per COSTED cell (`workflow_node_cost`)
 * — `null` when the run has never costed a single cell (nothing to average),
 * distinct from "zero leaves to spawn" (a real, well-defined zero). */
function measuredAverageTokensPerCell(database: Database.Database, runId: string): number | null {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in), 0) AS ti, COALESCE(SUM(tokens_out), 0) AS to_
       FROM workflow_node_cost WHERE run_id = ?`,
    )
    .get(runId) as { n: number | bigint; ti: number | bigint; to_: number | bigint };
  const n = Number(row.n);
  if (n === 0) return null;
  return (Number(row.ti) + Number(row.to_)) / n;
}

interface ClassifyContext {
  readonly facade: PreviewCacheFacade;
  readonly spawnsByOwner: ReadonlyMap<string, OwnerSpawns>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly faults: readonly string[];
  readonly pauseReason: string | null;
}

function classifyNode(node: Node, ctx: ClassifyContext): PreviewNodeOutcome {
  const { facade, spawnsByOwner, outputs, faults, pauseReason } = ctx;
  const hits = facade.hitsByOwner.get(node.id);
  const spawns = spawnsByOwner.get(node.id);
  if (node.type === "workflow" && ((hits?.count ?? 0) > 0 || (spawns?.count ?? 0) > 0)) {
    return {
      node_id: node.id,
      type: node.type,
      outcome: "nested",
      cells_replayed: hits?.count ?? 0,
      cells_to_recompute: spawns?.cellIds.size ?? 0,
      leaves_to_spawn: spawns?.count ?? 0,
    };
  }
  if ((spawns?.count ?? 0) > 0) {
    const reason = facade.missReasonByOwner.get(node.id) ?? "never_completed";
    return { node_id: node.id, type: node.type, outcome: "recompute", reason };
  }
  if ((hits?.count ?? 0) > 0) {
    return { node_id: node.id, type: node.type, outcome: "replay" };
  }
  if (node.type === "checkpoint" && pauseReason === CHECKPOINT_PAUSE) {
    return { node_id: node.id, type: node.type, outcome: "checkpoint_pending" };
  }
  const output = outputs[node.id];
  if (output === null && faults.includes(`${node.id}: upstream null`)) {
    return { node_id: node.id, type: node.type, outcome: "upstream_missing" };
  }
  if (pauseReason === TOKEN_BUDGET_PAUSE) {
    return { node_id: node.id, type: node.type, outcome: "token_budget_exhausted" };
  }
  return { node_id: node.id, type: node.type, outcome: "unknown" };
}

/** Seeds a pending checkpoint's OWN `default` (service.ts:657's rule) —
 * without it, a preview of a run paused at an ANSWERED-BY-DEFAULT checkpoint
 * would report `checkpoint_pending` for a node a real resume sails through. */
function seededCheckpointAnswers(
  pauseReason: string | null,
  checkpoint: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> {
  if (pauseReason !== CHECKPOINT_PAUSE || checkpoint === null) return {};
  const nodeId = checkpoint.node_id;
  if (typeof nodeId !== "string" || nodeId === "" || !("default" in checkpoint)) return {};
  return { [nodeId]: checkpoint.default };
}

/** #462: a real engine, a dry runtime, a read-only cache — never a
 * hand-rolled re-derivation of any cell's identity. See the module comment
 * for the full design. */
export async function previewResume(deps: PreviewDeps): Promise<PreviewResult | PreviewError> {
  const row = deps.repository.getRunState(deps.runId);
  if (row === null) return { error: `unknown workflow run '${deps.runId}'` };
  const view = durableFromRow(row);
  if (view.spec === null) return { error: `workflow run '${deps.runId}' has no persisted spec` };
  if (view.status === "running") {
    const expiry = deps.locks.runLeaseExpiry(deps.runId, deps.now);
    if (expiry !== null) return { error: busyErrorMessage(deps.runId, expiry, deps.now) };
  }
  const parsedBase = validateSpec(view.spec);
  if (isValidationError(parsedBase))
    return { error: `invalid persisted spec: ${parsedBase.message}` };
  const spec: WorkflowSpec =
    deps.route === undefined ? parsedBase : applyRouteOverrideToSpec(parsedBase, deps.route);

  const seeded = seedSpend(deps.repository, deps.runId);
  const dummyOwnership: WorkflowCacheOwnership = { fence: -1, holder: "preview", now: deps.now };
  const realCache = new SqliteWorkflowCache(deps.database, deps.runId, () => dummyOwnership, {
    repository: deps.repository,
  });
  const facade = new PreviewCacheFacade(realCache);
  const runtime = new DryRuntime();
  const control = idleRunControl();
  const engine = new WorkflowEngine({
    ...engineBaseOptions(
      runtime,
      deps.runId,
      deps.tiers,
      deps.loader,
      seededCheckpointAnswers(view.pause_reason, view.checkpoint),
    ),
    ...routeOverrideOption(deps.route),
    cache: facade,
    budget: new Budget({
      tokenBudget: view.token_budget,
      tokensIn: seeded.tokensIn,
      tokensOut: seeded.tokensOut,
    }),
    control,
    logError: () => undefined, // faults land in result.faults; stderr noise is not this tool's job
  });

  const result = await engine.run(spec, view.args);

  const spawnsByOwner = new Map<string, OwnerSpawns>();
  for (const spawned of runtime.spawns) {
    const owner = firstSegment(spawned.nodePath[0] ?? "");
    const bucket = spawnsByOwner.get(owner) ?? { count: 0, cellIds: new Set<string>() };
    bucket.count += 1;
    bucket.cellIds.add(spawned.cellId);
    spawnsByOwner.set(owner, bucket);
  }

  const classifyContext: ClassifyContext = {
    facade,
    spawnsByOwner,
    outputs: result.outputs,
    faults: result.faults,
    pauseReason: control.pauseReason,
  };
  const nodes = topologicalOrder(spec).map((node) => classifyNode(node, classifyContext));

  const leavesToSpawn = runtime.spawns.length;
  const average = measuredAverageTokensPerCell(deps.database, deps.runId);
  const estimatedTokensToRepay = average === null ? null : Math.round(leavesToSpawn * average);
  const estimateBasis: "measured_average" | null = average === null ? null : "measured_average";

  return {
    run_id: deps.runId,
    route_applied: deps.route !== undefined,
    pivots_used: view.pivots.length,
    nodes,
    cells_replayed: facade.totalHits,
    tokens_saved: facade.totalTokensSaved,
    leaves_to_spawn: leavesToSpawn,
    estimated_tokens_to_repay: estimatedTokensToRepay,
    estimate_basis: estimateBasis,
    engine_faults: result.engineFaults,
  };
}

function requireString(args: ToolArguments, key: string): string | { readonly error: string } {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "")
    return { error: `workflow_preview requires a non-empty string '${key}'` };
  return value;
}

/** Same rule `tool.ts:73-90` (`run_workflow`'s own `route` validation)
 * applies — duplicated, not imported: `tool.ts` has no exported helper for
 * it (the checks are inlined in `WorkflowTool.run`) and is out of this
 * issue's `Files`. */
function parseRouteArg(value: unknown): RouteOverride | undefined | { readonly error: string } {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { error: "'route' must be an object with a string 'provider' and/or 'model'" };
  const record = value as Readonly<Record<string, unknown>>;
  const validShape =
    (record.provider !== undefined || record.model !== undefined) &&
    (record.provider === undefined || typeof record.provider === "string") &&
    (record.model === undefined || typeof record.model === "string");
  if (!validShape)
    return { error: "'route' must be an object with a string 'provider' and/or 'model'" };
  if (typeof record.provider === "string" && record.provider.trim() === "")
    return { error: "'route.provider' must be a non-empty string (not just whitespace)" };
  if (typeof record.model === "string" && record.model.trim() === "")
    return { error: "'route.model' must be a non-empty string (not just whitespace)" };
  return {
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
  };
}

/** `database`/`home` are enough — `home` resolves the operator tier map
 * (`workflow_tiers.json`, the SAME file `WorkflowService` reads per launch),
 * `database` builds a fresh `WorkflowRepository`/`LockRepository` (both
 * cheap, stateless wrappers — never a second connection). Issue #484:
 * `session-tools.ts` now threads in the SAME `templateLoader(home)` #464
 * wired into `WorkflowService` (`chat.ts`/`dashboard.ts`) — a `workflow`
 * node previews `nested` whenever a real resume would run one. `loader`
 * stays optional here only for callers with no operator template library
 * at all (tests, or a `home` predating #464); missing it still previews
 * `unknown`, matching `engine.ts:838`'s "workflow loader unavailable". */
export function workflowPreviewHandler(
  database: Database.Database,
  home: string,
  loader?: WorkflowLoader,
): ToolHandler {
  return async (args) => {
    const runId = requireString(args, "run_id");
    if (typeof runId !== "string") return toolError(runId.error);
    const route = parseRouteArg(args.route);
    if (route !== undefined && "error" in route) return toolError(route.error);

    const tiers = readTiers(join(home, OPERATOR_TIERS_FILE));
    if (tiers instanceof TiersError) return toolError(tiers.message);

    const result = await previewResume({
      database,
      repository: new WorkflowRepository(database),
      locks: new LockRepository(database),
      tiers,
      ...(loader === undefined ? {} : { loader }),
      runId,
      ...(route === undefined ? {} : { route }),
      now: Math.floor(Date.now() / 1000),
    });
    if ("error" in result) return toolError(result.error);
    return toolResult(undefined, { ...result });
  };
}
