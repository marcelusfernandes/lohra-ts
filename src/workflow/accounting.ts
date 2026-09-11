import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";

export type RunStatus = "complete" | "degraded" | "failed" | "cancelled" | "paused";

export class NodeCost {
  readonly usage: Usage;
  readonly provider: string | null;
  readonly model: string | null;

  constructor(init: { usage?: Usage; provider?: string | null; model?: string | null } = {}) {
    this.usage = init.usage ?? usage();
    this.provider = init.provider ?? null;
    this.model = init.model ?? null;
    Object.freeze(this);
  }

  merge(next: Usage, provider: string | null, model: string | null): NodeCost {
    const first = this.usage.inputTokens + this.usage.outputTokens === 0;
    const same = first || (this.provider === provider && this.model === model);
    return new NodeCost({
      usage: combineUsage(this.usage, next) ?? usage(),
      provider: same ? provider : null,
      model: same ? model : null,
    });
  }
}
export class RunResult {
  readonly outputs: Record<string, unknown> = {};
  readonly faults: string[] = [];
  nullCount = 0;
  validationRetries = 0;
  /** Leaves re-spawned after attempt 0 — every case where a retry
   * re-invokes collectLeaf (a NEW leaf), never one that steers the same
   * leaf in place (issue #247). runAgent's empty-output retry and
   * runPipeline's per-stage retry (empty output OR failed schema
   * validation — same loop, same re-spawn) both count. A schema mismatch
   * on an `agent` node does NOT: collectLeaf's own validation loop steers
   * the SAME leaf (counted in validationRetries instead) — runAgent passes
   * its schema straight into collectLeaf, runPipeline passes null and
   * re-validates the settled output itself, outside collectLeaf, which is
   * why only the pipeline path re-spawns. */
  leafRespawns = 0;
  capTrips = 0;
  engineFaults = 0;
  nodesTotal = 0;
  tokensIn = 0;
  tokensOut = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  reasoningTokens = 0;
  usageUncertainLeaves = 0;
  /** Total tool calls the sandbox denied across every leaf of this run (or
   * this stretch, before service.ts folds in a prior stretch's total on
   * resume — #246). Advisory: never read by `deriveStatus`. */
  sandboxRefusals = 0;
  /** `"<nodeId>: sandbox refused N tool call(s)"` per leaf that had any —
   * kept OUT of `faults` on purpose so a refusal alone never flips `status`
   * (#246); `resultView` (service-rollup.ts) folds both lists together for
   * display, `deriveStatus` below reads only `faults`. */
  readonly sandboxFaults: string[] = [];
  readonly nodeCosts: Record<string, NodeCost> = {};
  forcingFallbacks = 0;
  status: RunStatus = "complete";
  pauseReason: string | null = null;
  pauseFault: string | null = null;
  retryAfter: number | null = null;
  checkpoint: Readonly<Record<string, unknown>> | null = null;

  get nullRate(): number {
    return this.nodesTotal === 0 ? 0 : this.nullCount / this.nodesTotal;
  }
}

export function deriveStatus(result: RunResult): RunStatus {
  if (result.nodesTotal > 0 && result.nullCount >= result.nodesTotal) return "failed";
  if (result.faults.length > 0 || result.nullCount > 0) return "degraded";
  return "complete";
}

export function addUsageToResult(
  result: RunResult,
  nodeId: string,
  next: Usage,
  provider: string | null,
  model: string | null,
  usageUncertain = false,
): void {
  result.tokensIn += next.inputTokens;
  result.tokensOut += next.outputTokens;
  result.cacheReadTokens += next.cacheReadTokens;
  result.cacheWriteTokens += next.cacheWriteTokens;
  result.reasoningTokens += next.reasoningTokens;
  if (usageUncertain) result.usageUncertainLeaves += 1;
  result.nodeCosts[nodeId] = (result.nodeCosts[nodeId] ?? new NodeCost()).merge(
    next,
    provider,
    model,
  );
}

/** Advisory only (#246): never touches `faults`/`status` — a leaf whose
 * every tool call the sandbox denied is still a `complete` leaf, because the
 * refusal may be the policy working as intended, not the leaf failing.
 * Called from `debitLeaf` (engine-utils.ts, #348) — that function already
 * scopes `nodeId` (`scopedCheckpointId`) for `nodeCosts`, and this reuses the
 * same scoped id, so engine.ts's `account()` needs no separate call site of
 * its own (`arquivo-grande` zero-growth budget). */
export function recordSandboxRefusals(result: RunResult, nodeId: string, refusals: number): void {
  if (refusals <= 0) return;
  result.sandboxRefusals += refusals;
  result.sandboxFaults.push(`${nodeId}: sandbox refused ${String(refusals)} tool call(s)`);
}

/** `runNested` (engine.ts) calls this in place of its own former
 * `this.result.leafRespawns += result.leafRespawns;` line (never part of
 * the `nested-fold-removed` mutation anchor, workflow-executor-mutants.ts —
 * that anchor's `before` ends at `forcingFallbacks`, the statement just
 * above) — folding `leafRespawns` here too, alongside the two new fields,
 * keeps this a SWAP, not an addition: engine.ts's own line count for the
 * nested-workflow fold stays exactly what it was before PR #316 round 2 (a
 * nested sub-run's refusals were folding into eleven OTHER parent counters
 * already but never into these two). */
export function foldNestedCounters(result: RunResult, nested: RunResult, reference: string): void {
  result.leafRespawns += nested.leafRespawns;
  result.sandboxRefusals += nested.sandboxRefusals;
  result.sandboxFaults.push(...nested.sandboxFaults.map((fault) => `sub[${reference}]: ${fault}`));
}
