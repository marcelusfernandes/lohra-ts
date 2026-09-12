import { createHash } from "node:crypto";

import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(canonical).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}: ${canonical(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(`<${typeof value}>`);
}

export function contentHash(...parts: readonly unknown[]): string {
  return createHash("sha256").update(canonical(parts), "utf8").digest("hex");
}

/** Issue #461: the ONLY thing that ever bumps this is a change to the parts
 * a cell's own type hashes (`runAgent`/`runParallel`/... in engine.ts,
 * `loopCellParts`/`replayOrCollectBranch`/... in engine-utils.ts) — never a
 * schema migration or a routine release. Bump it in the SAME PR as that
 * change (`tests/workflow-cache-stamp.test.ts` pins both the constant and
 * the root hash formula in one `it`, so a drift between them is a single
 * red test, not two). It travels beside the cell (`identity_version`
 * column, `state/schema.ts`'s `addedColumns`), never inside the content
 * hash itself — decision 3 of épico #458 ("marca, nunca invalida",
 * `docs/decisions/2026-09-10-cache-escopo-irmaos.md`): a bump never
 * invalidates a durable cell, it only marks a replay `version_state:
 * "stale"` instead of `"current"`. */
export const CELL_IDENTITY_VERSION = "1";

export interface CacheLookup {
  readonly hit: boolean;
  readonly output: unknown;
  readonly cost: Usage | null;
  /** Only set on a MISS, and only when the caller named a `nodeId` (#461):
   * `"never_completed"` when this (run, node) pair has no cell at all yet,
   * `"identity_changed"` when it does — under a DIFFERENT hash — meaning
   * the node's own cell identity moved (route pivot, prompt/schema edit,
   * a bumped `CELL_IDENTITY_VERSION`...) since that cell was written. */
  readonly miss?: "never_completed" | "identity_changed";
  /** Only set on a HIT: whether the replayed cell's own `identity_version`
   * stamp matches this version (`"current"`), predates the column
   * entirely (`"unstamped"` — a pre-#461 database), or names an older,
   * different version (`"stale"`). Marked, never invalidated — the replay
   * happens exactly the same in all three cases. */
  readonly versionState?: "current" | "stale" | "unstamped";
}

export interface WorkflowCacheOwnership {
  readonly fence: number;
  readonly holder: string;
  readonly now: number;
}

export interface WorkflowCache {
  /** `nodeId` (issue #368) is the SCOPED checkpoint id of the caller — it
   * never affects the lookup key (a cell is keyed by `hash` alone). The
   * decorator (`auditedWorkflowCache`, audit-cache.ts) still uses it only
   * to NAME the `cache.replayed`/`cache.missed` event's `node_id`; the two
   * concrete caches below (#461) use it, on a MISS, to classify `miss` as
   * `"never_completed"` or `"identity_changed"` — a cache that ignores the
   * argument entirely (never implementing that classification) is still a
   * valid `WorkflowCache`, just one whose misses never carry a reason. */
  get(runId: string, hash: string, nodeId?: string): CacheLookup;
  put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Usage | null,
    ownership?: WorkflowCacheOwnership,
  ): boolean;
  totalCost(runId: string): Readonly<{ inputTokens: number; outputTokens: number }>;
  totalSplit(runId: string): Usage;
}

interface Cell {
  readonly output: unknown;
  readonly nodeId: string;
  readonly cost: Usage;
  readonly identityVersion: string;
}

export class MemoryWorkflowCache implements WorkflowCache {
  private readonly cells = new Map<string, Cell>();
  private readonly refuseWrite: ((runId: string, hash: string) => boolean) | undefined;

  constructor(options: { readonly refuseWrite?: (runId: string, hash: string) => boolean } = {}) {
    this.refuseWrite = options.refuseWrite;
  }

  private key(runId: string, hash: string): string {
    return `${runId}\0${hash}`;
  }

  /** #461: "did (runId, nodeId) ever land a cell, under ANY hash?" — the
   * same question `hasCellForNode` (`state/workflow-repository.ts`)
   * answers for the durable cache, scanning here since this cache has no
   * table/index of its own. */
  private hasCellForNode(runId: string, nodeId: string): boolean {
    const prefix = `${runId}\0`;
    for (const [key, cell] of this.cells) {
      if (key.startsWith(prefix) && cell.nodeId === nodeId) return true;
    }
    return false;
  }

  get(runId: string, hash: string, nodeId?: string): CacheLookup {
    const cell = this.cells.get(this.key(runId, hash));
    if (cell === undefined) {
      if (nodeId === undefined) return Object.freeze({ hit: false, output: null, cost: null });
      const miss = this.hasCellForNode(runId, nodeId) ? "identity_changed" : "never_completed";
      return Object.freeze({ hit: false, output: null, cost: null, miss });
    }
    const versionState = cell.identityVersion === CELL_IDENTITY_VERSION ? "current" : "stale";
    return Object.freeze({
      hit: true,
      output: structuredClone(cell.output),
      cost: structuredClone(cell.cost),
      versionState,
    });
  }

  put(runId: string, hash: string, nodeId: string, output: unknown, cost: Usage | null): boolean {
    if (this.refuseWrite?.(runId, hash) === true) return false;
    this.cells.set(
      this.key(runId, hash),
      Object.freeze({
        output: structuredClone(output),
        nodeId,
        cost: cost ?? usage(),
        identityVersion: CELL_IDENTITY_VERSION,
      }),
    );
    return true;
  }

  totalCost(runId: string): Readonly<{ inputTokens: number; outputTokens: number }> {
    const split = this.totalSplit(runId);
    return Object.freeze({ inputTokens: split.inputTokens, outputTokens: split.outputTokens });
  }

  totalSplit(runId: string): Usage {
    let total: Usage | null = null;
    for (const [key, cell] of this.cells) {
      if (key.startsWith(`${runId}\0`)) total = combineUsage(total, cell.cost);
    }
    return total ?? usage();
  }
}
