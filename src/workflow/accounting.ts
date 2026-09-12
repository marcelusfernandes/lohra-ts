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

/** #501: the exact, fixed suffix BOTH `recordLeafSideChannels` and
 * `recordCrossStretchArtifactCollisions` below build a collision advisory
 * with (never free-form leaf/tool text) — one constant so the two producers
 * and `collisionKeyOf`'s parser below can never drift apart. */
const COLLISION_FAULT_MARKER = ": artifact path written by 2 leaves: ";

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
  /** Leaves whose `usage` above already includes a portion ESTIMATED from a
   * call aborted in flight (`ChildResult.partial`, runtime.ts; ADR 0005,
   * #517/M16-S2) — always a SUBSET of `usageUncertainLeaves` above (an
   * estimate is never a real measurement), never the reverse: a leaf that
   * merely never measured usage (#232) sets `usageUncertainLeaves` alone.
   * Incremented in `recordLeafSideChannels` below; folded from a nested
   * sub-run in `foldNestedCounters`, like every other per-leaf counter
   * there. */
  partialLeaves = 0;
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
  // #517: counted regardless of `collected.status` — same as every other
  // side channel this function already reads off the raw `ChildResult`,
  // never gated on "complete" vs "failed"/"cancelled".
  if (collected.partial === true) result.partialLeaves += 1;
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
      result.artifactFaults.push(`${nodeId}${COLLISION_FAULT_MARKER}${artifact.path}`);
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
    // #539: `artifact.node_id` is the UNSPACED `sub[${reference}]:name`
    // contract (`foldNestedCounters` below) for a nested artifact —
    // `faultPrefixFromNodeId` rewrites that leading chain to the spaced
    // form every OTHER fault-string producer in this module uses, so this
    // fault's scope parses identically to theirs.
    result.artifactFaults.push(
      `${faultPrefixFromNodeId(artifact.node_id)}${COLLISION_FAULT_MARKER}${artifact.path}`,
    );
  }
}

/** #501/#512: neither `recordCrossStretchArtifactCollisions` above (a fresh
 * `artifactCollisionPaths` per `RunResult`, blind to what a PRIOR stretch
 * already reported) nor plainly concatenating a prior stretch's
 * `artifact_faults` onto the current one's own notices that a path a prior
 * stretch already flagged is the SAME path a later stretch's own leaf just
 * rewrote — so both the live view (`foldArtifactFaults` below, folded by
 * `service.ts`'s terminal write) and the PERSISTED `pause_payload_json`
 * (`pausePayloadOf`, route-override.ts, which calls
 * `dedupeArtifactFaultsByPath` directly since #512 — it no longer persists
 * the raw concatenation the way it did before #512) can end up with two
 * advisories for one path, with different `node_id`s. Both call sites
 * dedupe through `dedupeArtifactFaultsByPath` below, on the WHOLE merged
 * list (never just the newest stretch's own faults), so a duplicate already
 * baked into an older stretch's persisted payload is cleaned up — and,
 * since #512, never re-persisted either: a cold read (`durableRollup`) and
 * a live one now always agree. First occurrence of a path wins — the
 * earliest stretch's own advisory and its `node_id` survive every fold
 * after it; a non-collision message (the artifact-cap fault above) has no
 * path and is always kept.
 *
 * #512: the de-dup key is (scope, path), never path alone.
 * `foldNestedCounters` below prefixes every one of a nested sub-run's OWN
 * fault strings with `sub[${reference}]: ` (one prefix per nesting level,
 * so a doubly-nested sub-run reads `sub[a]: sub[b]: ...`) — a nested
 * sub-workflow's own collision (`sub[ref]: n: ...: /x`) and a top-level
 * leaf's collision on the SAME literal path string (`m: ...: /x`) are two
 * DIFFERENT physical files (each scoped to its own working root) that
 * merely happen to share a path string; collapsing them into one advisory
 * would silently drop a real collision. `NESTED_SCOPE_PREFIX_RE` strips
 * only that leading `sub[...]:` chain off the front of the fault string —
 * never the node id right after it — so two faults share a key only when
 * they share BOTH the same nesting scope and the same normalized path.
 *
 * #539: the SAME scope can show up in TWO literal shapes. `foldNestedCounters`
 * spells a fault's scope prefix with a space (`sub[${reference}]: `, via
 * `nestedScopePrefix` below) but `RunArtifact.node_id` is the UNSPACED
 * `sub[${reference}]:${nodeId}` (a `node_id` contract, pinned by
 * `tests/workflow-artifacts.test.ts:331` — never rewritten).
 * `recordCrossStretchArtifactCollisions` below cunhas its fault from that
 * `node_id` — `faultPrefixFromNodeId` rewrites the unspaced chain to the
 * spaced form before building the fault text, so every FRESH fault this
 * module writes is spaced from here on. This regex still accepts BOTH forms
 * (space optional per level) — and `collisionKeyOf` below re-inserts any
 * missing space before using the match as a key — so a fault string already
 * persisted unspaced (written before this fix) still normalizes to the SAME
 * scope key as its spaced counterpart. */
const NESTED_SCOPE_PREFIX_RE = /^(?:sub\[[^\]]*\]: ?)*/;

interface CollisionKey {
  readonly scope: string;
  readonly path: string;
}

function collisionKeyOf(fault: string): CollisionKey | null {
  const at = fault.indexOf(COLLISION_FAULT_MARKER);
  if (at === -1) return null;
  const rawScope = NESTED_SCOPE_PREFIX_RE.exec(fault)?.[0] ?? "";
  // #539: `sub[ref]:` (no space — the unspaced, legacy/node_id-derived
  // form) normalizes to `sub[ref]: ` so both forms of the SAME scope always
  // produce the SAME key.
  const scope = rawScope.replace(/\]:(?!\s)/g, "]: ");
  const path = normalizedArtifactPath(fault.slice(at + COLLISION_FAULT_MARKER.length));
  return { scope, path };
}

export function dedupeArtifactFaultsByPath(faults: readonly string[]): string[] {
  // scope -> paths already kept for that scope — a `Map` of `Set`s instead
  // of one flat `Set<string>` so two DIFFERENT scopes sharing the same
  // literal path text (#512) can never be confused by however scope and
  // path happen to be joined into a single string.
  const seenByScope = new Map<string, Set<string>>();
  const kept: string[] = [];
  for (const fault of faults) {
    const key = collisionKeyOf(fault);
    if (key !== null) {
      const seen = seenByScope.get(key.scope) ?? new Set<string>();
      if (seen.has(key.path)) continue;
      seen.add(key.path);
      seenByScope.set(key.scope, seen);
    }
    kept.push(fault);
  }
  return kept;
}

/** #539/#540: the ONE place that spells the SPACED `sub[${reference}]: `
 * scope prefix a fault string carries — `foldNestedCounters` below,
 * `faultPrefixFromNodeId` right below, and `engine.ts`'s own
 * `runNested`(the `result.faults` fold) all call this instead of inlining
 * the template literal, so no producer of a scoped fault string can drift
 * out of the shape `NESTED_SCOPE_PREFIX_RE`/`collisionKeyOf` above parse.
 * Never used for `RunArtifact.node_id` itself — that stays the UNSPACED
 * `sub[${reference}]:${nodeId}` contract pinned by
 * `tests/workflow-artifacts.test.ts:331`. */
export function nestedScopePrefix(reference: string): string {
  return `sub[${reference}]: `;
}

/** #539: `recordCrossStretchArtifactCollisions` above cunhas a NEW fault
 * straight from an artifact's `node_id` — which, for a nested artifact
 * `foldNestedCounters` folded in, is the UNSPACED `sub[${reference}]:name`
 * chain (one segment per nesting level, e.g. `sub[a]:sub[b]:leaf`). Rewrites
 * only the LEADING chain of `sub[...]:` segments into the SPACED
 * `nestedScopePrefix` form every other fault-string producer in this module
 * uses — a plain, unscoped `node_id` (no leading `sub[...]:` at all) comes
 * back unchanged. */
function faultPrefixFromNodeId(nodeId: string): string {
  const chain = /^(?:sub\[[^\]]*\]:)*/.exec(nodeId)?.[0] ?? "";
  if (chain === "") return nodeId;
  const refs: string[] = [];
  for (const match of chain.matchAll(/sub\[([^\]]*)\]:/g)) refs.push(match[1] ?? "");
  return `${refs.map(nestedScopePrefix).join("")}${nodeId.slice(chain.length)}`;
}

/** Called once from service.ts's terminal fold, in place of the plain
 * `result.artifactFaults.unshift(...priorView.artifact_faults)` that call
 * site used before #501. `artifacts` (unrelated, never deduped — every
 * write is a legitimate manifest entry; only a COLLISION message needs a
 * first-occurrence rule) still gets a plain `unshift` right above this
 * call, unchanged. This function mutates `result.artifactFaults` IN PLACE,
 * rather than returning a new array, so the call site keeps the exact
 * one-line shape it had before #501 (service.ts's own zero-growth
 * ceiling). `RunResult.artifactCollisionPaths` — the per-run de-dup Set —
 * is NOT updated here on purpose: that Set only ever guards a SINGLE
 * `RunResult`'s own live accounting (`recordLeafSideChannels`,
 * `recordCrossStretchArtifactCollisions` above) against re-flagging a path
 * it already saw. By the time this fold runs, a prior stretch's own
 * `RunResult` no longer exists in memory — there is no live Set left to
 * consult — so `dedupeArtifactFaultsByPath` re-derives the same
 * first-occurrence rule straight from the persisted STRINGS instead. */
export function foldArtifactFaults(result: RunResult, priorFaults: readonly string[]): void {
  const merged = dedupeArtifactFaultsByPath([...priorFaults, ...result.artifactFaults]);
  result.artifactFaults.splice(0, result.artifactFaults.length, ...merged);
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
  result.partialLeaves += nested.partialLeaves;
  result.sandboxRefusals += nested.sandboxRefusals;
  // #540: moved from engine.ts's own runNested (item 7) — the general
  // `faults` array now goes through the SAME nestedScopePrefix every other
  // fold below already used, instead of an inline literal only this one
  // ever spelled.
  result.faults.push(...nested.faults.map((fault) => `${nestedScopePrefix(reference)}${fault}`));
  result.sandboxFaults.push(
    ...nested.sandboxFaults.map((fault) => `${nestedScopePrefix(reference)}${fault}`),
  );
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
    ...nested.artifactFaults.map((fault) => `${nestedScopePrefix(reference)}${fault}`),
  );
}
