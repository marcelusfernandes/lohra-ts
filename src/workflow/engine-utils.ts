import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";
import { addUsageToResult, recordFaultKind, recordSandboxRefusals } from "./accounting.js";
import type { RunResult } from "./accounting.js";
import { contentHash, type WorkflowCache } from "./cache.js";
import type { WorkflowEngine } from "./engine.js";
import { isRouteFault, pausesRun, routeLesson } from "./route-faults.js";
import {
  DEFAULT_LEAF_MAX_ITERATIONS,
  QUOTA_EXHAUSTED,
  type LeafExecution,
  type RunControl,
  type WorkflowLoader,
} from "./engine-contract.js";
import { MAX_NODE_MAX_ITERATIONS, MAX_NODE_RETRIES } from "./nodes.js";
import { isEmptyOutput } from "./output-validation.js";
import { resolveValue } from "./refs.js";
import type { Awaitable, CausalContext, ChildResult } from "./runtime.js";
import { resolveInlineSchema, validateSpec } from "./schema.js";
import type { TierMap } from "./tiers.js";
import { Node, ValidationError } from "./types.js";
export interface Routing {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function clampInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

export function nonEmpty(value: unknown): boolean {
  return value !== null && !isEmptyOutput(value);
}

export function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (typeof value === "function" || typeof value === "symbol") return `<${typeof value}>`;
  try {
    return JSON.stringify(value);
  } catch {
    return `<${typeof value}>`;
  }
}

export function verifyPrompt(finding: unknown, lens: unknown): string {
  return `You are a skeptic reviewing through the lens of: ${renderValue(lens)}. Try hard to REFUTE the following finding. Default to refuted=true if you find any real problem.\n\nFINDING:\n${renderValue(finding)}\n\nRespond with ONLY JSON: {"refuted": <true|false>, "reason": "<why>"}.`;
}

export function strictResolve(value: unknown, context: Readonly<Record<string, unknown>>): unknown {
  const scan = (item: unknown): boolean => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/gu)) {
        const path = match[1]?.split(".") ?? [];
        let current: unknown = context;
        for (const part of path) current = asRecord(current)?.[part];
        if (current === null || current === undefined) return false;
      }
    } else if (Array.isArray(item)) {
      return item.every(scan);
    } else if (asRecord(item) !== null) {
      return Object.values(asRecord(item) ?? {}).every(scan);
    }
    return true;
  };
  return scan(value) ? resolveValue(value, context) : null;
}

export function combine(total: Usage, next: Usage): Usage {
  return combineUsage(total, next) ?? usage();
}

/**
 * #238: below `pipeline.min_success_ratio`, the run seals `failed` with a
 * fault citing measured vs. required — a floor `runPipeline` (`engine.ts`)
 * checks once per call, win or timeout. Returns `true` (having already
 * recorded the fault) on a breach, so the call site stays one line; `false`
 * (no field, or `total` is 0 and a ratio can't be measured) leaves the
 * caller's status alone.
 */
export function sealPipelineRatio(
  recordFault: (message: string) => void,
  node: Node,
  completed: number,
  total: number,
): boolean {
  const ratio = node.fields.min_success_ratio;
  if (typeof ratio !== "number" || total === 0) return false;
  const measured = completed / total;
  if (measured >= ratio) return false;
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  recordFault(
    `${node.id}: min_success_ratio breach — ${String(completed)}/${String(total)} items ` +
      `completed (${pct(measured)}), required ${pct(ratio)}`,
  );
  return true;
}

/**
 * #238: `loop_until_dry.budget` is a real per-node token ceiling —
 * `runLoop` (`engine.ts`) calls this once per round, after charging that
 * round's usage. Returns `true` (having already recorded the fault) once
 * spend reaches the budget, so the round loop can `break` in one line.
 * `round`/`rounds`/`empty`/`stopAfter` mirror the round loop's OWN
 * continuation test (`round + 1 < rounds && empty < stopAfter`) — when that
 * is already `false` (the loop was ending on its own, by `max_rounds` or
 * `stop_after_k_empty`), reaching the budget stopped nothing real and would
 * be a spurious fault on a run that otherwise completes cleanly (PR #341
 * review, round 1).
 */
export function stopForBudget(
  recordFault: (message: string) => void,
  node: Node,
  spent: Usage,
  round: number,
  rounds: number,
  empty: number,
  stopAfter: number,
): boolean {
  if (round + 1 >= rounds || empty >= stopAfter) return false;
  const budget = node.fields.budget;
  if (typeof budget !== "number") return false;
  const total = spent.inputTokens + spent.outputTokens;
  if (total < budget) return false;
  recordFault(
    `${node.id}: node budget exhausted after ${String(total)} of ${String(budget)} tokens; loop stopped`,
  );
  return true;
}

/** Extracted so `runLoop`'s round predicate ("came back empty") reads as one
 * line at the call site — no behavior of its own beyond the OR the inline
 * version already had. */
export function isDryRound(output: unknown): boolean {
  return (
    isEmptyOutput(output) ||
    (Array.isArray(output) && output.length === 0) ||
    (asRecord(output) !== null && Object.keys(asRecord(output) ?? {}).length === 0)
  );
}

export function resultUsage(result: ChildResult): Usage {
  return result.usage ?? usage();
}

export function routingOf(node: Node, tiers: TierMap): Routing {
  const tier =
    typeof node.fields.tier === "string" ? tiers[node.fields.tier as keyof TierMap] : undefined;
  return {
    ...(typeof node.fields.provider === "string"
      ? { provider: node.fields.provider }
      : tier?.provider === undefined
        ? {}
        : { provider: tier.provider }),
    ...(typeof node.fields.model === "string"
      ? { model: node.fields.model }
      : tier?.model === undefined
        ? {}
        : { model: tier.model }),
    ...(typeof node.fields.effort === "string"
      ? { effort: node.fields.effort }
      : tier?.effort === undefined
        ? {}
        : { effort: tier.effort }),
  };
}

/** Issue #329: `collectLeaf`'s per-request setup (routing, iteration cap,
 * whether the schema is force-called as a tool) is pure given `node`,
 * `tiers` and the resolved `schema` — pulling it out of `engine.ts` keeps
 * that file from growing when the second `collect()`'s timeout path grows
 * a branch to match the first one's. */
export interface LeafRequestOptions {
  readonly routing: Routing;
  readonly maxIterations: number;
  readonly forced: boolean;
}

export function resolveLeafRequestOptions(
  node: Node,
  tiers: TierMap,
  schema: Readonly<Record<string, unknown>> | null,
): LeafRequestOptions {
  return {
    routing: routingOf(node, tiers),
    maxIterations: Object.hasOwn(node.fields, "max_iterations")
      ? Math.min(Number(node.fields.max_iterations), MAX_NODE_MAX_ITERATIONS)
      : DEFAULT_LEAF_MAX_ITERATIONS,
    forced: schema !== null && node.fields.tool_less === true,
  };
}

/** Issue #329 (extended #426): the FIRST `collect()`'s non-"running" failure path — debit usage, then branch by kind: quota pauses the run (no fault), a route kind (`route-faults.ts`) pauses with a lesson the same way, anything else records a plain fault. Pure given `engine`'s three methods and the `account` callback, so it stays out of `engine.ts` (#313's timeout branch lives here for the same reason). */
export function nonCompleteFirstCollectResult(
  engine: Pick<WorkflowEngine, "noteQuotaExhausted" | "noteRouteFault" | "recordFault">,
  account: (nodeId: string, id: string, collected: ChildResult) => void,
  nodeId: string,
  routing: Routing,
  id: string,
  collected: ChildResult,
  total: Usage,
): LeafExecution {
  account(nodeId, id, collected);
  if (collected.errorKind === QUOTA_EXHAUSTED) {
    // Not this leaf's own failure — the whole run is out of quota.
    engine.noteQuotaExhausted(nodeId, collected.retryAfter ?? null);
  } else if (isRouteFault(collected.errorKind)) {
    engine.noteRouteFault(nodeId, routeLesson(collected, nodeId, routing));
  } else {
    const kind =
      collected.errorKind === null || collected.errorKind === undefined
        ? ""
        : ` (${collected.errorKind})`;
    engine.recordFault(
      `${nodeId}: leaf ${collected.status}${kind}: ${renderValue(collected.output ?? "no detail").slice(0, 200)}`,
    );
  }
  return { output: null, usage: total, complete: false };
}

/** Issue #329: pulls the `StructuredOutput` tool call's arguments out of a
 * completed leaf when the schema was forced as a tool — pure given
 * `collected` and `forced`, so it moves out of `engine.ts` alongside
 * `resolveLeafRequestOptions` for the same reason. */
export function extractForcedOutput(
  collected: ChildResult,
  forced: boolean,
): Readonly<{ output: unknown; usedFallback: boolean }> {
  if (!forced) return { output: collected.output, usedFallback: false };
  const call = collected.toolCalls
    ?.map(asRecord)
    .find((candidate) => candidate?.name === "StructuredOutput");
  return call !== undefined && call !== null
    ? { output: call.arguments ?? call.args ?? null, usedFallback: false }
    : { output: collected.output, usedFallback: true };
}

/** Issue #336: pulled out of `engine.ts`'s `schemaOf` method to make room
 * for the new `stoppedByControl` predicate (below) without growing the
 * file — pure given `node` and `schemas` (an inline schema on the node
 * itself wins; a `schema_ref` name falls back to the run's own schema
 * table), so it moves the same way `resolveLeafRequestOptions` (#329)
 * already did for the same reason. */
export function resolveNodeSchema(
  node: Node | Readonly<Record<string, unknown>>,
  schemas: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const fields = node instanceof Node ? node.fields : node;
  const inline = resolveInlineSchema(fields.schema, schemas);
  if (inline !== null) return inline;
  const reference = fields.schema_ref;
  return typeof reference === "string" ? asRecord(schemas[reference]) : null;
}

/** Issue #336: pulled out of `engine.ts`'s `causal` method — same reason as
 * `resolveNodeSchema` above — to make room for `ParallelBranchDeps` growing
 * a `control` field (below) without growing the file. Pure given the
 * engine's own identity fields and the per-call `role`/`cellId`/`extra`;
 * `nodePath` is already `[...nodeScope, currentNode]` by the time it gets
 * here, so this never touches `nodeScope` itself. */
export function buildCausalContext(
  runId: string,
  segmentId: string,
  nodePath: readonly string[],
  cellId: string,
  role: string,
  extra: { itemIndex?: number; stageIndex?: number; attempt?: number } = {},
): CausalContext {
  return Object.freeze({
    runId,
    segmentId,
    nodePath: Object.freeze([...nodePath]),
    cellId,
    role,
    attempt: extra.attempt ?? 0,
    turn: 0,
    ...(extra.itemIndex === undefined ? {} : { itemIndex: extra.itemIndex }),
    ...(extra.stageIndex === undefined ? {} : { stageIndex: extra.stageIndex }),
  });
}

export function routingIdentity(node: Node, tiers: TierMap): readonly unknown[] {
  if (!["model", "tier", "effort", "provider"].some((field) => Object.hasOwn(node.fields, field)))
    return [];
  const resolved = routingOf(node, tiers);
  return [resolved.model ?? null, resolved.effort ?? null, resolved.provider ?? null];
}

/**
 * #238: `loop_until_dry`'s cell identity, with `budget` folded in ONLY when
 * the spec sets it (`Object.hasOwn`, not a plain lookup — `undefined` would
 * still add an array element and change the hash for every loop that has no
 * `budget` at all). A different `budget` value now hashes to a different
 * cell, so re-running with a bigger budget after an earlier truncated stop
 * (`stopForBudget` in `engine.ts`) re-executes instead of replaying the
 * truncated result (PR #341 review, round 1) — and with no `budget` set,
 * this is byte-identical to the pre-#238 hash (durable resume compatible).
 */
export function loopCellParts(
  node: Node,
  tiers: TierMap,
  firstPrompt: unknown,
  bodySchema: unknown,
  stopAfter: number,
  rounds: number,
): readonly unknown[] {
  return [
    node.id,
    "loop_until_dry",
    firstPrompt,
    bodySchema,
    stopAfter,
    rounds,
    ...routingIdentity(node, tiers),
    ...(Object.hasOwn(node.fields, "budget") ? [node.fields.budget] : []),
  ];
}

/** What `runParallel` hands `replayOrCollectBranch` — engine data fields
 * (no binding needed) plus the one engine method (`collectLeaf`) the helper
 * can't reimplement, bound by the caller so `this` stays correct. `spec` is
 * `WorkflowEngine.specIdentity`; `cell`/`cachePut`'s bodies are reproduced
 * here from `contentHash`/`cache.put` (both already engine-utils imports or
 * exports) rather than bound, so the helper needs no engine method for them.
 * #332: `specIdentity` now folds in `nodeScope` (`engine.ts`'s `run()`), so
 * every per-branch cell built from `deps.spec` here is scope-qualified for
 * free — two SIBLING `workflow` nodes reusing the same nested template with
 * identical branches no longer share one sibling's branch cells. */
export interface ParallelBranchDeps {
  readonly runId: string;
  readonly cache: WorkflowCache;
  readonly result: RunResult;
  readonly spec: readonly unknown[];
  readonly tiers: TierMap;
  /** Issue #336: `stillDying` below needs it, not just `result`, to see a
   * PARENT's `requestPause()` (shared by reference, `runNested`) or a
   * `cancel()` that never mirrors into `result.pauseFault`. */
  readonly control: RunControl;
  /** #348: this engine's own `nodeScope`, so a nested engine's branch/group
   * cost is `scopedCheckpointId`-qualified like `account`/`cacheGet` — root
   * callers pass `[]` (no-op). */
  readonly nodeScope: readonly string[];
  readonly collectLeaf: (
    node: Node,
    prompt: string,
    schema: Readonly<Record<string, unknown>> | null,
    options: {
      readonly role: string;
      readonly cellId: string;
      readonly itemIndex: number;
      readonly attempt?: number;
    },
  ) => Promise<LeafExecution>;
}

/** Issue #241: a branch with its own cached success replays it (no spawn);
 * a fresh spawn's cache write lets a LATER resume replay it too. The real
 * cost lands on `deps.result` either way, so a full-group cache hit that
 * later replays the group's own recorded total is replaying the right sum.
 * `node.id` is the cost's owner — `runParallel` set it as the current node
 * before spawning any branch, so it's the same value either way. */
export async function replayOrCollectBranch(
  deps: ParallelBranchDeps,
  node: Node,
  index: number,
  prompt: string,
  attempt = 0,
): Promise<LeafExecution> {
  const routing = routingIdentity(node, deps.tiers);
  const branchHash = contentHash(...deps.spec, node.id, "parallel", index, prompt, ...routing);
  const owner = scopedCheckpointId(deps.nodeScope, node.id);
  const found = deps.cache.get(deps.runId, branchHash, owner);
  if (found.hit) {
    if (found.cost !== null) addUsageToResult(deps.result, owner, found.cost, null, null);
    return { output: found.output, usage: found.cost ?? usage(), complete: true };
  }
  const leaf = await deps.collectLeaf(node, prompt, null, {
    role: "parallel.branch",
    cellId: branchHash,
    itemIndex: index,
    attempt,
  });
  if (nonEmpty(leaf.output))
    deps.cache.put(deps.runId, branchHash, node.id, leaf.output, leaf.usage);
  return leaf;
}

/** Issue #336: the SAME stop condition `collectLeaf`'s own pre-spawn check
 * enforces (engine.ts, right after `pool.acquire()`) — shared by every
 * retry-loop's counting guard (`runAgent`, `runPipeline`, and `stillDying`
 * below) so none of them can credit a respawn that `collectLeaf` itself is
 * about to refuse to spawn. `control` is shared by REFERENCE with a PARENT
 * engine (`runNested` passes the very same object down, never a copy) — a
 * `requestPause()` on the parent flips `paused` on the object a NESTED
 * engine's own `collectLeaf` reads too, even though the nested engine's own
 * `result.pauseFault` (a separate `RunResult` per engine) stays null.
 * `cancel()` (engine.ts) never routes through `pause()`, so it never
 * touches `pauseFault` at all — `control.cancelled` is the only place that
 * shows up. `aborted` is the one stop signal with no home on `control`:
 * `runPipeline`'s own per-item deadline flag, threaded in only by the call
 * sites that have one. */
export function stoppedByControl(control: RunControl, aborted?: () => boolean): boolean {
  return control.paused || control.cancelled || (aborted?.() ?? false);
}

/** `output === null` from `collectLeaf` also covers a run that's already
 * stopped (token budget/quota exhausted by a SIBLING branch, the operator,
 * a `cancel()`, or — once nested — a PARENT's `requestPause()`) —
 * `collectLeaf` short-circuits to a null leaf with no spawn, no fault, no
 * charge (engine.ts, right after `pool.acquire()`) once `stoppedByControl`
 * is true. A sibling's retry loop must not mistake that for a fresh death
 * and keep spinning through its own `retries` cap doing nothing: checking
 * the SAME predicate stops the loop once the stop is KNOWN. Two branches
 * that both start a retry in the same tick can still race past this check
 * before either has set it — bounded to at most one wasted attempt per
 * branch (the guard catches it on the NEXT iteration), never a full spin
 * through `retries` per stuck branch; still finite (invariant 3), not
 * silent (whichever branch actually exhausts the budget still faults via
 * `pause()`). */
function stillDying(leaf: LeafExecution, deps: ParallelBranchDeps): boolean {
  return leaf.output === null && !stoppedByControl(deps.control);
}

/** Issue #242: a branch that comes back DEAD (`output === null` — timed
 * out, cancelled, or the runtime reported a failure) gets refed up to
 * `node.fields.retries` (0-3, default 0 — absent means today's behavior).
 * A branch with a legitimate EMPTY output (no schema, so "" or [] is real
 * data, not a failure) is never retried — only `=== null` triggers a
 * respawn, same distinction `nonEmpty` draws for caching. Each retry reuses
 * `deps.collectLeaf`, which already runs `gateTokens`/`gateFanout(1, true)`
 * and already records a fault with cause on every dead leaf — so the
 * budget stop-line and the fault trail both come from the existing path;
 * this only owns the loop, `leafRespawns`, and the `stillDying` guard. */
export async function collectBranchWithRetries(
  deps: ParallelBranchDeps,
  node: Node,
  index: number,
  prompt: string,
): Promise<LeafExecution> {
  const retries = clampInteger(node.fields.retries, 0, MAX_NODE_RETRIES);
  let leaf = await replayOrCollectBranch(deps, node, index, prompt, 0);
  for (let attempt = 1; attempt <= retries && stillDying(leaf, deps); attempt += 1) {
    deps.result.leafRespawns += 1;
    leaf = await replayOrCollectBranch(deps, node, index, prompt, attempt);
  }
  return leaf;
}

/** #348: pulled out of `engine.ts`'s `account` (room for the `nodeScope`
 * qualifier). `scopedCheckpointId` scopes `nodeId` like checkpoint ids
 * (#319: root's `nodeScope` is `[]`), so `runNested`'s fold disambiguates
 * siblings reusing one template; `budget.chargeTokens` stays in `account`. */
export function debitLeaf(
  result: RunResult,
  leafCosts: Map<string, Usage>,
  nodeScope: readonly string[],
  nodeId: string,
  id: string,
  collected: ChildResult,
): Usage {
  const next = resultUsage(collected);
  const uncertain = collected.usageUncertain === true;
  const owner = scopedCheckpointId(nodeScope, nodeId);
  leafCosts.set(id, next);
  addUsageToResult(
    result,
    owner,
    next,
    collected.provider ?? null,
    collected.model ?? null,
    uncertain,
  );
  // Plain `nodeId` (never `owner`) reads like a `faults` entry, never double-scoped.
  recordSandboxRefusals(result, nodeId, collected.sandboxRefusals ?? 0);
  // #426: generalized from `!== QUOTA_EXHAUSTED` — any kind that pauses the run gets re-run on resume, so it must never leak into `faultKinds` (double-counts otherwise).
  if (!pausesRun(collected.errorKind)) recordFaultKind(result, collected.errorKind ?? null);
  return next;
}

/** Issue #313: a leaf that dies by TIMEOUT still spent real tokens up to the
 * moment `runtime.cancel` tore it down — `collect()`'s "running" `ChildResult`
 * is the only place that spend could ever show up, and only some runtimes
 * populate `usage` on it (the production orchestration-runtime timeout path
 * currently never does, always returning `{ status: "running", output: null
 * }`). When it IS present, debit it through the exact same `account()` a
 * completed leaf uses — idempotent by leaf id, so a retry's own NEW id is a
 * fresh, separate charge, never a double one on THIS id. When it's absent,
 * the debit must never be a silent zero: `usageUncertain` (#232) makes the
 * gap visible in the rollup instead of pretending the attempt cost nothing. */
export function timeoutLeafResult(
  account: (nodeId: string, id: string, collected: ChildResult) => void,
  nodeId: string,
  id: string,
  collected: ChildResult,
): LeafExecution {
  const measured = collected.usage;
  const uncertain =
    measured === null || measured === undefined || collected.usageUncertain === true;
  const debited = measured ?? usage();
  account(nodeId, id, { ...collected, usage: debited, usageUncertain: uncertain });
  return { output: null, usage: debited, complete: false };
}

/** Issue #329: `collectLeaf`'s SECOND `collect()` — the re-collect after
 * `runtime.steer()` in the schema-validation retry loop — can time out
 * (`status: "running"`) exactly like the first one, but used to fall
 * through to the generic non-complete branch: `account()` only, no
 * `runtime.cancel(id)`, no timeout-named fault. That left the leaf alive
 * in the runtime and the usage gap invisible instead of `usageUncertain`.
 * `cancel`/`recordFault` are plain callbacks (not bound to `this`) on
 * purpose: the FIRST `collect()`'s inline `await this.runtime.cancel(id);
 * / this.recordFault(...)` is the anchor for the `timeout-no-cooperative-
 * cancel` mutant (`scripts/mutations/workflow-executor-mutants.ts`) and
 * stays untouched in `engine.ts` — this only backs the SECOND site, which
 * calls it instead of duplicating that inline block. */
export async function recollectLeafTimeout(
  cancel: (id: string) => Awaitable<void>,
  recordFault: (message: string) => void,
  account: (nodeId: string, id: string, collected: ChildResult) => void,
  nodeId: string,
  id: string,
  timeout: number,
  collected: ChildResult,
): Promise<LeafExecution> {
  await cancel(id);
  recordFault(`${nodeId}: leaf timeout after ${String(Math.trunc(timeout))}s (cancelled)`);
  return timeoutLeafResult(account, nodeId, id, collected);
}

function isZeroUsage(value: Usage): boolean {
  return (
    value.inputTokens === 0 &&
    value.outputTokens === 0 &&
    value.cacheReadTokens === 0 &&
    value.cacheWriteTokens === 0 &&
    value.reasoningTokens === 0
  );
}

/** PR #305 round 2: the group cell writes NULL cost — each branch cell
 * already recorded its own real cost once (`replayOrCollectBranch` above),
 * so writing the group's own total too double-counts every token in
 * `workflow_node_cost` (`WorkflowService.seedSpend` sums cost rows per run
 * and can inflate `tokens_spent` to 2x on resume). A group cache HIT has no
 * branch spawn to carry the cost, so this re-sums each branch's OWN cell —
 * cheap reads, never a spawn — and records that as the node's cost: the
 * real total, from the one place it's still recorded.
 *
 * Issue #308: a per-branch cell can go missing (e.g. `putCacheCellWithCost`
 * refused by `database is locked` for one branch write) while the group
 * cell still lands — the old `?? usage()` fallback made that indistinguishable
 * from a branch that legitimately cost zero, silently under-reporting
 * `nodeCosts`. `deps.cache.get` for the group's OWN cell tells the two
 * databases apart: this version always writes the group cell with `cost:
 * null`, which every `WorkflowCache` stores back as an all-zero `Usage`
 * (never a literal `null` on a hit) — so a non-zero group cost can only be
 * an OLD database's direct total, written before per-branch cells existed
 * at all, and `deps.cache`'s caller (`cacheGet` in engine.ts) already added
 * that real total to `deps.result` before this ran; resumming zero branch
 * cells here would only double it. Only the all-zero (this-version) case
 * re-sums branches and only THAT case can tell a missing cell apart from a
 * database with no branch cells to begin with — so only that case faults. */
export function recordGroupReplayCost(
  deps: ParallelBranchDeps,
  node: Node,
  resolved: readonly unknown[],
  cached: unknown,
  groupHash: string,
): unknown {
  const owner = scopedCheckpointId(deps.nodeScope, node.id);
  const groupCost = deps.cache.get(deps.runId, groupHash, owner).cost;
  if (groupCost !== null && !isZeroUsage(groupCost)) return cached;
  const routing = routingIdentity(node, deps.tiers);
  const total = resolved.reduce((sum: Usage, p, i) => {
    const hash = contentHash(...deps.spec, node.id, "parallel", i, renderValue(p), ...routing);
    const found = deps.cache.get(deps.runId, hash, owner);
    if (!found.hit) {
      deps.result.faults.push(`group replay: per-branch cell missing for ${hash}`);
      return sum;
    }
    return combine(sum, found.cost ?? usage());
  }, usage());
  addUsageToResult(deps.result, owner, total, null, null);
  return cached;
}

/** #243: a raw answers value substituted for a checkpoint id that the
 * PARENT also owns — `resolveCheckpoint` treats presence of this sentinel
 * as "claimed by someone else's checkpoint", never as a real answer. */
export const CHECKPOINT_AMBIGUOUS: unique symbol = Symbol("checkpoint-ambiguous");

/** The dotted answer key a checkpoint listens on: the raw id at the root
 * (`nodeScope` empty — unchanged, so every existing flat answer keeps
 * working), the ancestor chain joined by `.` once nested (`sub.confirm`). */
export function scopedCheckpointId(nodeScope: readonly string[], id: string): string {
  return nodeScope.length === 0 ? id : [...nodeScope, id].join(".");
}

/** #243: what a NESTED engine receives as `checkpointAnswers` — a copy
 * where every raw key that also names a checkpoint at the ROOT scope is
 * replaced by `CHECKPOINT_AMBIGUOUS`. The nested checkpoint can then tell
 * "answered under my key" apart from "this raw key means the PARENT's
 * checkpoint" and refuse the latter instead of silently answering both
 * from one flat `{confirm: "..."}`. #319: `ambiguousIds` is no longer only
 * the root's own ids — `siblingAnswers` below folds in any id shared by two
 * or more SIBLING `workflow` nodes too, so this function itself needs no
 * change to cover that case; it only ever sees the final set. */
export function nestedCheckpointAnswers(
  answers: Readonly<Record<string, unknown>>,
  ambiguousIds: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers))
    out[key] = ambiguousIds.has(key) ? CHECKPOINT_AMBIGUOUS : value;
  return Object.freeze(out);
}

/** #319: `nestedCheckpointAnswers` above only ever refused a raw key that
 * named a checkpoint at the ROOT scope — two SIBLING `workflow` nodes whose
 * own children happen to reuse the same checkpoint id (root silent about
 * it) still both consumed one flat raw answer. `MAX_WORKFLOW_DEPTH = 1`
 * bounds nesting to exactly one level, so every checkpoint id a NESTED
 * engine's answers could ever need to refuse is either a root checkpoint's
 * own id or one of the CURRENT spec's `workflow` nodes' nested checkpoint
 * ids — this runs ONCE, in `run()`, before any node executes, folding both
 * into the one ambiguous-id set `nestedCheckpointAnswers` already knows how
 * to apply. Collecting incrementally as each sibling actually RAN would let
 * whichever sibling runs FIRST through unrefused, since its OWN sibling's
 * ids are still unknown at that point — the root loop is sequential, one
 * node at a time — so this has to happen up front, over ALL of them, not
 * just the ones already executed.
 *
 * A `ref` that only resolves once an EARLIER node's own output exists (a
 * template naming `${someNode.field}`) can't be resolved here — this pass
 * only has `{ args }`, no node outputs yet — so that sibling's own ids stay
 * silently absent from the set; a collision reached only through such a
 * dynamic ref is a known, DOCUMENTED gap (not a silent failure of the
 * checkpoint itself: once actually reached, it still resolves — correctly
 * when unique, incorrectly shared when colliding, exactly the pre-#319
 * behavior). A `ref` that fails to load or fails `validateSpec` here is
 * skipped, not swallowed:
 * `runNested` loads the very same ref again when the node actually runs
 * and records its own named fault there — this pass defers to that path
 * rather than duplicating it. */
export async function siblingAnswers(
  answers: Readonly<Record<string, unknown>>,
  ordered: readonly Node[],
  args: Readonly<Record<string, unknown>>,
  loader: WorkflowLoader | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const ambiguous = new Set(
    ordered.filter((node) => node.type === "checkpoint").map((node) => node.id),
  );
  if (loader !== undefined) {
    const context = Object.freeze({ args: Object.freeze({ ...args }) });
    const seenOnce = new Set<string>();
    for (const node of ordered) {
      if (node.type !== "workflow") continue;
      const reference = strictResolve(node.fields.ref, context);
      if (typeof reference !== "string") continue;
      try {
        const parsed = validateSpec(await loader(reference));
        if (parsed instanceof ValidationError) continue;
        for (const child of parsed.nodes)
          if (child.type === "checkpoint") {
            if (seenOnce.has(child.id)) ambiguous.add(child.id);
            seenOnce.add(child.id);
          }
      } catch {
        continue;
      }
    }
  }
  return nestedCheckpointAnswers(answers, ambiguous);
}

export interface CheckpointResolution {
  readonly scoped: string;
  readonly matched: boolean;
  readonly answer: unknown;
  /** What `runCheckpoint` should pause with when NOT matched — names the
   * collision (invariant 2: never silent) or, absent one, the plain
   * unanswered-checkpoint text. Unused when `matched`. */
  readonly message: string;
  /** #330: which branch below produced `message` — "none" when `matched` or
   * plain-unanswered. "raw" means the SCOPED id (`scoped`) still resolves it
   * on the next resume, exactly as `message` already says. "scoped" means
   * `scoped` itself is the dead end — it collides with a ROOT checkpoint's
   * own literal id, an author-time rename, not a different resume answer —
   * so `checkpointPausePayload` must not let its `node_id` look like an
   * ordinary resumable key. */
  readonly collision: "none" | "raw" | "scoped";
}

/** Scoped key wins; the raw id is the pre-#243 compat fallback, refused —
 * `matched: false` with a named `message`, never silently applied — when it
 * carries `CHECKPOINT_AMBIGUOUS`. #318: the sentinel can ALSO land under the
 * scoped key itself — `nestedCheckpointAnswers` (above) replaces any answers
 * key that names a ROOT checkpoint, dotted or not, so a root checkpoint id
 * that happens to equal a child's own SCOPED form (e.g. a root id literally
 * "sub.confirm" beside node "sub"'s child checkpoint "confirm") plants the
 * sentinel there too. Both branches refuse it the same way: named fault,
 * never a matched answer. */
export function resolveCheckpoint(
  answers: Readonly<Record<string, unknown>>,
  nodeScope: readonly string[],
  nodeId: string,
): CheckpointResolution {
  const scoped = scopedCheckpointId(nodeScope, nodeId);
  if (Object.hasOwn(answers, scoped)) {
    const scopedAnswer = answers[scoped];
    if (scopedAnswer !== CHECKPOINT_AMBIGUOUS)
      return { scoped, matched: true, answer: scopedAnswer, message: "", collision: "none" };
    // Unlike the raw branch below, there is no MORE-scoped key to fall back
    // to — `scoped` already IS the scoped form, and it collides with a ROOT
    // checkpoint's own literal id (a root id spelled with the same dots,
    // e.g. "sub.confirm"). The fix is at author time: rename one of the two
    // checkpoint ids so they stop sharing a key.
    const message =
      `${nodeId}: scoped checkpoint id '${scoped}' collides with a ROOT checkpoint's own ` +
      `literal id — rename one of the two checkpoint ids to remove the collision`;
    return { scoped, matched: false, answer: null, message, collision: "scoped" };
  }
  if (Object.hasOwn(answers, nodeId)) {
    const raw = answers[nodeId];
    if (raw !== CHECKPOINT_AMBIGUOUS)
      return { scoped, matched: true, answer: raw, message: "", collision: "none" };
    // #319: the raw id can now collide with the ROOT's own checkpoint OR
    // with a SIBLING nested workflow's own checkpoint of the same id —
    // `nestedCheckpointAnswers`/`siblingAnswers` mark both the same way, so
    // this branch no longer knows (and doesn't need to) which one it was.
    const message =
      `${nodeId}: checkpoint id '${nodeId}' collides with another checkpoint at a ` +
      `different scope — answer with the scoped id '${scoped}'`;
    return { scoped, matched: false, answer: null, message, collision: "raw" };
  }
  return {
    scoped,
    matched: false,
    answer: null,
    message: `${nodeId}: checkpoint waiting for answer`,
    collision: "none",
  };
}

/** Applies a resolved checkpoint answer: caches it under the node's cell (so
 * a replay never re-consults `checkpointAnswers`) and returns it. */
export function applyCheckpointAnswer(
  cache: WorkflowCache,
  runId: string,
  hash: string,
  nodeId: string,
  answer: unknown,
): unknown {
  cache.put(runId, hash, nodeId, answer, null);
  return answer;
}

/** The pause payload for an unanswered checkpoint — `node_id` is the
 * SCOPED form (#243), so a resume answers the right occurrence. #330: when
 * `collision === "scoped"`, that SCOPED form is itself the dead end (it
 * collides with a ROOT checkpoint's own literal id — `resolveCheckpoint`'s
 * comment on that branch) — resuming with THIS `node_id` unchanged repauses
 * forever, since the answer would land under the same colliding key again.
 * `rename_hint` says so instead of letting the payload look like an
 * ordinary resumable checkpoint. The "raw" collision needs no such hint:
 * `resolved.scoped` there is a genuinely different, working key — the one
 * `resolved.message` already tells the caller to use. */
export function checkpointPausePayload(
  node: Node,
  resolved: CheckpointResolution,
  prompt: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    node_id: resolved.scoped,
    prompt,
    ...(Object.hasOwn(node.fields, "default") ? { default: node.fields.default } : {}),
    ...(resolved.collision === "scoped"
      ? {
          rename_hint:
            `resuming with node_id '${resolved.scoped}' will collide again — it is a ROOT ` +
            `checkpoint's own literal id; rename one of the two checkpoint ids in the spec`,
        }
      : {}),
  });
}
