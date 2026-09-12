import { posix } from "node:path";
import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";
import type { ErrorKind } from "../transports/error-kinds.js";
import type { ChildResult } from "./runtime.js";

/** #485: comparison-only normalization (never `resolve` — a leaf's `path` is
 * relative to its own working root, an absolute-looking one is still just a
 * string here) so `./x` and `x` are recognized as the same file. The
 * RECORDED `path` (`RunArtifact.path` below) is always the raw string the
 * tool call received — this function never touches storage, only the
 * de-dup/collision comparisons that read it. */
function normalizedArtifactPath(raw: string): string {
  return posix.normalize(raw);
}

export type RunStatus = "complete" | "degraded" | "failed" | "cancelled" | "paused";

/** One `write_file` a run's leaves produced (#463). Snake_case on purpose:
 * this exact shape flows straight through `resultView`/`pausePayloadOf`/
 * `durableRollup` with no remapping. `node_id` is the PLAIN node id when
 * recorded here (never `scopedCheckpointId`-qualified, same rule
 * `recordSandboxRefusals` already follows) — a nested sub-run's own
 * artifacts get the `sub[${reference}]:` prefix only when `foldNestedCounters`
 * folds them into the parent. `sub_id` is the writing leaf's own subId. */
export interface RunArtifact {
  readonly node_id: string;
  readonly sub_id: string;
  readonly path: string;
  readonly bytes: number;
}

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
  /** `write_file` manifest for this run (or this stretch, before service.ts
   * folds a prior stretch's total in on resume — #463). Advisory: never
   * read by `deriveStatus`. */
  readonly artifacts: RunArtifact[] = [];
  /** `"<nodeId>: artifact path written by 2 leaves: <path>"` (once per
   * colliding path) and `"<nodeId>: N artifact records dropped past the
   * cap"` — molded on `sandboxFaults`: kept OUT of `faults` so a collision
   * alone never flips `status` (doctrine #248, decision 6 of épico #458). */
  readonly artifactFaults: string[] = [];
  /** #485: normalized paths (`normalizedArtifactPath`) already reported as
   * colliding — de-dup only, never serialized/exposed (not part of
   * `pausePayloadOf`/`durableRollup`/any other payload). Keeps a repeated
   * path — the same leaf's own batch, or a later stretch revisiting one a
   * prior stretch already flagged — from pushing more than one advisory
   * fault for it. */
  readonly artifactCollisionPaths: Set<string> = new Set();
  /** The `ErrorKind` of each provider-classified leaf failure — a typed
   * subset of `faults` (#399), never parsed out of its message text: many
   * `faults` entries (timeout, empty output, schema mismatch, engine fault,
   * nested `sub[ref]:` ones, the advisory sandbox refusals `resultView`
   * folds in) carry no `errorKind` at all. Never gains a `quota_exhausted`
   * entry either: `debitLeaf`'s quota guard (engine-utils.ts) excludes it
   * before `recordFaultKind` is ever called. */
  readonly faultKinds: ErrorKind[] = [];
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

/** #463: the write-file manifest's own side channel, called from the SAME
 * `debitLeaf` call site `recordSandboxRefusals` above already occupies
 * (engine-utils.ts:485, a swap, not an add) — so every accounted leaf's
 * artifacts land here exactly once. A path already owned by a DIFFERENT
 * `subId` fires the collision fault — de-duped by `artifactCollisionPaths`
 * (#485) so the SAME leaf's own batch naming a path twice (after another
 * leaf already owns it) never pushes a second advisory for it — advisory
 * only, `faults`/`status` never see it (doctrine #248, decision 6 of épico
 * #458). Paths compare `normalizedArtifactPath` (#485: `./x` and `x` are the
 * same file), but `RunArtifact.path` always keeps the raw string. */
export function recordLeafSideChannels(
  result: RunResult,
  nodeId: string,
  subId: string,
  collected: ChildResult,
): void {
  recordSandboxRefusals(result, nodeId, collected.sandboxRefusals ?? 0);
  for (const artifact of collected.artifacts ?? []) {
    const key = normalizedArtifactPath(artifact.path);
    const otherOwners = new Set(
      result.artifacts
        .filter((entry) => normalizedArtifactPath(entry.path) === key)
        .map((entry) => entry.sub_id),
    );
    otherOwners.delete(subId);
    if (otherOwners.size === 1 && !result.artifactCollisionPaths.has(key)) {
      result.artifactCollisionPaths.add(key);
      result.artifactFaults.push(`${nodeId}: artifact path written by 2 leaves: ${artifact.path}`);
    }
    result.artifacts.push({
      node_id: nodeId,
      sub_id: subId,
      path: artifact.path,
      bytes: artifact.bytes,
    });
  }
  const dropped = collected.artifactsDropped ?? 0;
  if (dropped > 0) {
    result.artifactFaults.push(
      `${nodeId}: ${String(dropped)} artifact records dropped past the cap`,
    );
  }
}

/** #485: `recordLeafSideChannels` above only ever compares a leaf's own
 * write against artifacts THIS stretch's own leaves already produced — a
 * resume starts a brand-new `RunResult` with an empty `artifacts` list, so a
 * stretch 2 leaf writing a path a stretch 1 leaf already owned went
 * undetected. Called once, from `pausePayloadOf` (route-override.ts), right
 * after a stretch's engine run settles, against the prior stretches' own
 * accumulated `artifacts`. Never compares `sub_id`: unlike
 * `recordLeafSideChannels` (where the SAME leaf naming a path twice must
 * never collide with itself), the stretch boundary itself is proof these are
 * two separate executions — even a plain, uncached node re-running on resume
 * and rewriting its OWN prior path counts (#248 doctrine: any two distinct
 * leaf executions racing the same path are advisory-worthy). Same de-dup set
 * as `recordLeafSideChannels`, so a path already flagged never fires twice. */
export function recordCrossStretchArtifactCollisions(
  result: RunResult,
  priorArtifacts: readonly RunArtifact[],
): void {
  if (priorArtifacts.length === 0) return;
  const priorPaths = new Set(
    priorArtifacts.map((artifact) => normalizedArtifactPath(artifact.path)),
  );
  for (const artifact of result.artifacts) {
    const key = normalizedArtifactPath(artifact.path);
    if (!priorPaths.has(key) || result.artifactCollisionPaths.has(key)) continue;
    result.artifactCollisionPaths.add(key);
    result.artifactFaults.push(
      `${artifact.node_id}: artifact path written by 2 leaves: ${artifact.path}`,
    );
  }
}

/** Molde `recordSandboxRefusals`: a no-op on `null` keeps the common case (a
 * complete leaf with nothing to name) a cheap early return — but a
 * `complete` leaf is NOT guaranteed `errorKind === null`: a dead turn
 * (`dead_turn`, #429, `child-runner.ts`) is `status: complete` with a
 * non-null `errorKind`, and it lands in `faultKinds` here exactly like any
 * other kind. Called from `debitLeaf` (engine-utils.ts, #399) — the same
 * function `recordSandboxRefusals` above already reaches for every
 * accounted leaf, quota-excluded the same way `nonCompleteFirstCollectResult`
 * excludes it from `faults`, so `faultKinds` never outpaces the events it
 * types. */
export function recordFaultKind(result: RunResult, kind: ErrorKind | null): void {
  if (kind === null) return;
  result.faultKinds.push(kind);
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
  // Vocabulary, not text (#399) — never `sub[${reference}]:`-prefixed like
  // `sandboxFaults`/`faults` above: a kind stays the SAME value regardless
  // of which nested run raised it.
  result.faultKinds.push(...nested.faultKinds);
  // #463: `node_id` gets the SAME `sub[${reference}]:` scope `nodeCosts`
  // already uses (engine.ts) — never re-checked for collision against the
  // parent's own artifacts, only within one flat RunResult's own leaves.
  result.artifacts.push(
    ...nested.artifacts.map((artifact) => ({
      ...artifact,
      node_id: `sub[${reference}]:${artifact.node_id}`,
    })),
  );
  result.artifactFaults.push(
    ...nested.artifactFaults.map((fault) => `sub[${reference}]: ${fault}`),
  );
}
