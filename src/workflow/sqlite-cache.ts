import type Database from "better-sqlite3";

import type { Usage } from "../pricing/types.js";
import { usage } from "../pricing/usage.js";
import type { StateWarning } from "../state/locks.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import type { CacheLookup, WorkflowCache, WorkflowCacheOwnership } from "./cache.js";

/**
 * Run-scoped SQLite NodeCache under the live-ownership guard: every put
 * (cell + cost in one transaction) is refused unless the presenting token is
 * the run's exactly-current fence with the current holder of an unexpired
 * lease. Reads are unfenced: a cell that already landed is honest data.
 */
export class SqliteWorkflowCache implements WorkflowCache {
  private readonly onWrite: (() => void) | undefined;
  /** The ONE guarded-write primitive; this cache owns no SQL guard of its own. */
  private readonly repository: WorkflowRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly runId: string,
    private readonly ownershipOf: () => WorkflowCacheOwnership,
    options: {
      readonly onWrite?: () => void;
      readonly repository?: WorkflowRepository;
      // Issue #135: only used when `repository` is NOT supplied — the
      // production path (service.ts) always passes `store.repository`,
      // which already carries the store's own sink. This is the "or an
      // option" half of that composition, for a caller that builds a
      // SqliteWorkflowCache directly.
      readonly warning?: (warning: StateWarning) => void;
    } = {},
  ) {
    this.onWrite = options.onWrite;
    this.repository = options.repository ?? new WorkflowRepository(database, options.warning);
  }

  public get(runId: string, hash: string): CacheLookup {
    return this.lookup(runId, hash);
  }

  private lookup(runId: string, hash: string): CacheLookup {
    const cell = this.database
      .prepare(
        "SELECT status, output_json FROM workflow_node_cache WHERE run_id = ? AND content_hash = ?",
      )
      .get(runId, hash) as { status: string; output_json: string | null } | undefined;
    if (cell === undefined) return Object.freeze({ hit: false, output: null, cost: null });
    const output = cell.output_json === null ? null : (JSON.parse(cell.output_json) as unknown);
    const costRow = this.database
      .prepare(
        `SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, reasoning_tokens
         FROM workflow_node_cost WHERE run_id = ? AND content_hash = ?`,
      )
      .get(runId, hash) as
      | {
          tokens_in: bigint | null;
          tokens_out: bigint | null;
          cache_read_tokens: bigint | null;
          cache_write_tokens: bigint | null;
          reasoning_tokens: bigint | null;
        }
      | undefined;
    const cost = usage({
      inputTokens: Number(costRow?.tokens_in ?? 0),
      outputTokens: Number(costRow?.tokens_out ?? 0),
      cacheReadTokens: Number(costRow?.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(costRow?.cache_write_tokens ?? 0),
      reasoningTokens: Number(costRow?.reasoning_tokens ?? 0),
    });
    return Object.freeze({ hit: true, output, cost });
  }

  public put(
    runId: string,
    hash: string,
    nodeId: string,
    output: unknown,
    cost: Usage | null,
    ownershipOverride?: WorkflowCacheOwnership,
  ): boolean {
    const ownership = ownershipOverride ?? this.ownershipOf();
    const priced =
      cost !== null &&
      (cost.inputTokens !== 0 ||
        cost.outputTokens !== 0 ||
        cost.cacheReadTokens !== 0 ||
        cost.cacheWriteTokens !== 0 ||
        cost.reasoningTokens !== 0);
    // Cell + cost in ONE transaction, through the shared guard: the cell's
    // INSERT carries the ownership guard, the cost INSERT only runs after that
    // success inside the same transaction ("priced or absent").
    const ok = this.repository.putCacheCellWithCost(
      this.runId,
      hash,
      nodeId,
      output === null ? null : JSON.stringify(output),
      "complete",
      ownership,
      priced
        ? {
            tokensIn: cost.inputTokens,
            tokensOut: cost.outputTokens,
            cacheRead: cost.cacheReadTokens,
            cacheWrite: cost.cacheWriteTokens,
            reasoning: cost.reasoningTokens,
          }
        : null,
    );
    if (ok) this.onWrite?.();
    return ok;
  }

  public totalCost(): Readonly<{ inputTokens: number; outputTokens: number }> {
    const split = this.totalSplit();
    return Object.freeze({ inputTokens: split.inputTokens, outputTokens: split.outputTokens });
  }

  public totalSplit(): Usage {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0) AS ti, COALESCE(SUM(tokens_out), 0) AS to_,
                COALESCE(SUM(cache_read_tokens), 0) AS cr,
                COALESCE(SUM(cache_write_tokens), 0) AS cw,
                COALESCE(SUM(reasoning_tokens), 0) AS rt
         FROM workflow_node_cost WHERE run_id = ?`,
      )
      .get(this.runId) as {
      readonly ti: bigint;
      readonly to_: bigint;
      readonly cr: bigint | null;
      readonly cw: bigint | null;
      readonly rt: bigint | null;
    };
    return usage({
      inputTokens: Number(row.ti),
      outputTokens: Number(row.to_),
      cacheReadTokens: Number(row.cr ?? 0),
      cacheWriteTokens: Number(row.cw ?? 0),
      reasoningTokens: Number(row.rt ?? 0),
    });
  }
}
