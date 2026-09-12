// Issue #368: `auditedWorkflowCache` decorates a `WorkflowCache` so every
// lookup and write a stretch makes against its node cache produces
// `cache.replayed`/`cache.missed`/`cache.stored`/`cache.unavailable` in the
// ledger — the economy (and the refusal) of a recomputed cell becomes
// auditable, not just visible in the SQLite cache tables directly.
//
// The fail-closed rule this shares with every other audit producer in this
// codebase (invariant 4, CLAUDE.md) is `recordAuditEvent`
// (`audit-producers.ts`, #365/#367), imported here rather than repeated —
// same reason #367's `audit-runtime.ts` imports it instead of a third copy.
import { recordAuditEvent, type AuditFailClosedDeps } from "./audit-producers.js";
import type { CacheLookup, WorkflowCache, WorkflowCacheOwnership } from "./cache.js";
import type { Usage } from "../pricing/types.js";

/** One decorator instance per ACQUISITION — same lifetime as
 * `createWorkflowAuditProducers` (`audit-producers.ts`), so every event this
 * decorator emits carries the SAME `segmentId` as the rest of the stretch. */
export interface AuditedCacheDeps extends AuditFailClosedDeps {
  readonly segmentId: string;
}

/** `cache.replayed`/`cache.stored` carry `usage` only when the cache reports
 * a cost — a cell written with `cost: null` (engine.ts:487, a `parallel`
 * group cell) stays silent on tokens rather than claim a zero that was never
 * measured. */
function usagePayload(cost: Usage | null): Readonly<Record<string, unknown>> {
  return cost === null
    ? {}
    : { usage: { tokens_in: cost.inputTokens, tokens_out: cost.outputTokens } };
}

/** Issue #461: `cache.missed`'s own `reason` — omitted (not `null`) when
 * `lookup.miss` is undefined, which happens exactly when the caller never
 * named a `nodeId` (cache.ts) for `get` to classify the miss with. */
function missPayload(miss: CacheLookup["miss"]): Readonly<Record<string, unknown>> {
  return miss === undefined ? {} : { reason: miss };
}

/** Issue #461: `cache.replayed`'s `usage` (unchanged) plus `version_state`
 * — omitted only for a cache that never classifies hits at all (a custom
 * `WorkflowCache` the decorator wraps that predates #461). */
function replayedPayload(
  cost: Usage | null,
  versionState: CacheLookup["versionState"],
): Readonly<Record<string, unknown>> {
  return {
    ...usagePayload(cost),
    ...(versionState === undefined ? {} : { version_state: versionState }),
  };
}

/**
 * Decorates `inner`: `get`/`put` delegate AND produce a `cache.*` event
 * around the same call; `totalCost`/`totalSplit` delegate with no event (an
 * aggregate read, not an individual cell's fate). `get`'s optional `nodeId`
 * (cache.ts:39) is forwarded to `inner` now (#461, `hasCellForNode`
 * classification), unlike before #461 when it only named the event's
 * `node_id` — `identity.sub_id` still never changes what `leaf.*` looks up
 * (audit-runtime.ts, #366), but a cache's own `get` genuinely uses this one.
 */
export function auditedWorkflowCache(inner: WorkflowCache, deps: AuditedCacheDeps): WorkflowCache {
  function record(runId: string, eventType: string, nodeId: string | null, payload: unknown): void {
    recordAuditEvent(deps, runId, {
      event_type: eventType,
      segment_id: deps.segmentId,
      node_id: nodeId,
      payload,
    });
  }

  return Object.freeze({
    get(runId: string, hash: string, nodeId?: string): CacheLookup {
      const lookup = inner.get(runId, hash, nodeId);
      record(
        runId,
        lookup.hit ? "cache.replayed" : "cache.missed",
        nodeId ?? null,
        lookup.hit ? replayedPayload(lookup.cost, lookup.versionState) : missPayload(lookup.miss),
      );
      return lookup;
    },
    put(
      runId: string,
      hash: string,
      nodeId: string,
      output: unknown,
      cost: Usage | null,
      ownership?: WorkflowCacheOwnership,
    ): boolean {
      const ok = inner.put(runId, hash, nodeId, output, cost, ownership);
      record(
        runId,
        ok ? "cache.stored" : "cache.unavailable",
        nodeId,
        ok ? usagePayload(cost) : { reason: "store_failed" },
      );
      return ok;
    },
    totalCost: (runId: string) => inner.totalCost(runId),
    totalSplit: (runId: string) => inner.totalSplit(runId),
  });
}
