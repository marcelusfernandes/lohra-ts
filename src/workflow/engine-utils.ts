import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";
import { addUsageToResult, type RunResult } from "./accounting.js";
import { contentHash, type WorkflowCache } from "./cache.js";
import type { LeafExecution } from "./engine-contract.js";
import { MAX_NODE_RETRIES } from "./nodes.js";
import { isEmptyOutput } from "./output-validation.js";
import { resolveValue } from "./refs.js";
import type { ChildResult } from "./runtime.js";
import type { TierMap } from "./tiers.js";
import { Node } from "./types.js";

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

export function routingIdentity(node: Node, tiers: TierMap): readonly unknown[] {
  if (!["model", "tier", "effort", "provider"].some((field) => Object.hasOwn(node.fields, field)))
    return [];
  const resolved = routingOf(node, tiers);
  return [resolved.model ?? null, resolved.effort ?? null, resolved.provider ?? null];
}

/** What `runParallel` hands `replayOrCollectBranch` — engine data fields
 * (no binding needed) plus the one engine method (`collectLeaf`) the helper
 * can't reimplement, bound by the caller so `this` stays correct. `spec` is
 * `WorkflowEngine.specIdentity`; `cell`/`cachePut`'s bodies are reproduced
 * here from `contentHash`/`cache.put` (both already engine-utils imports or
 * exports) rather than bound, so the helper needs no engine method for them. */
export interface ParallelBranchDeps {
  readonly runId: string;
  readonly cache: WorkflowCache;
  readonly result: RunResult;
  readonly spec: readonly unknown[];
  readonly tiers: TierMap;
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
  const found = deps.cache.get(deps.runId, branchHash);
  if (found.hit) {
    if (found.cost !== null) addUsageToResult(deps.result, node.id, found.cost, null, null);
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

/** `output === null` from `collectLeaf` also covers a run that's already
 * PAUSED (token budget/quota exhausted by a SIBLING branch, or the
 * operator) — `collectLeaf` short-circuits to a null leaf with no spawn,
 * no fault, no charge (engine.ts:235-236) once `this.control.paused` is
 * set. A sibling's retry loop must not mistake that for a fresh death and
 * keep spinning through its own `retries` cap doing nothing: `pause()`
 * (engine.ts:172-183) always writes `result.pauseFault` first, so checking
 * it stops the loop once the pause is KNOWN. Two branches that both start
 * a retry in the same tick can still race past this check before either
 * has set `pauseFault` — bounded to at most one wasted attempt per branch
 * (the guard catches it on the NEXT iteration), never a full spin through
 * `retries` per stuck branch; still finite (invariant 3), not silent
 * (whichever branch actually exhausts the budget still faults via
 * `pause()`). */
function stillDying(leaf: LeafExecution, deps: ParallelBranchDeps): boolean {
  return leaf.output === null && deps.result.pauseFault === null;
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
  const groupCost = deps.cache.get(deps.runId, groupHash).cost;
  if (groupCost !== null && !isZeroUsage(groupCost)) return cached;
  const routing = routingIdentity(node, deps.tiers);
  const total = resolved.reduce((sum: Usage, p, i) => {
    const hash = contentHash(...deps.spec, node.id, "parallel", i, renderValue(p), ...routing);
    const found = deps.cache.get(deps.runId, hash);
    if (!found.hit) {
      deps.result.faults.push(`group replay: per-branch cell missing for ${hash}`);
      return sum;
    }
    return combine(sum, found.cost ?? usage());
  }, usage());
  addUsageToResult(deps.result, node.id, total, null, null);
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
 * from one flat `{confirm: "..."}`. */
export function nestedCheckpointAnswers(
  answers: Readonly<Record<string, unknown>>,
  rootCheckpointIds: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers))
    out[key] = rootCheckpointIds.has(key) ? CHECKPOINT_AMBIGUOUS : value;
  return Object.freeze(out);
}

export interface CheckpointResolution {
  readonly scoped: string;
  readonly matched: boolean;
  readonly answer: unknown;
  /** What `runCheckpoint` should pause with when NOT matched — names the
   * collision (invariant 2: never silent) or, absent one, the plain
   * unanswered-checkpoint text. Unused when `matched`. */
  readonly message: string;
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
      return { scoped, matched: true, answer: scopedAnswer, message: "" };
    // Unlike the raw branch below, there is no MORE-scoped key to fall back
    // to — `scoped` already IS the scoped form, and it collides with a ROOT
    // checkpoint's own literal id (a root id spelled with the same dots,
    // e.g. "sub.confirm"). The fix is at author time: rename one of the two
    // checkpoint ids so they stop sharing a key.
    const message =
      `${nodeId}: scoped checkpoint id '${scoped}' collides with a ROOT checkpoint's own ` +
      `literal id — rename one of the two checkpoint ids to remove the collision`;
    return { scoped, matched: false, answer: null, message };
  }
  if (Object.hasOwn(answers, nodeId)) {
    const raw = answers[nodeId];
    if (raw !== CHECKPOINT_AMBIGUOUS) return { scoped, matched: true, answer: raw, message: "" };
    const message =
      `${nodeId}: checkpoint id '${nodeId}' collides with the parent's — ` +
      `answer with the scoped id '${scoped}'`;
    return { scoped, matched: false, answer: null, message };
  }
  return {
    scoped,
    matched: false,
    answer: null,
    message: `${nodeId}: checkpoint waiting for answer`,
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
 * SCOPED form (#243), so a resume answers the right occurrence. */
export function checkpointPausePayload(
  node: Node,
  resolved: CheckpointResolution,
  prompt: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    node_id: resolved.scoped,
    prompt,
    ...(Object.hasOwn(node.fields, "default") ? { default: node.fields.default } : {}),
  });
}
