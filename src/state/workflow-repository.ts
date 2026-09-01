import type Database from "better-sqlite3";

import type { StateWarning } from "./locks.js";
import { safeInteger } from "./values.js";

export interface Ownership {
  readonly fence: number;
  readonly holder: string;
  readonly now: number;
}

export interface RunStateFields {
  readonly name: string | null;
  readonly owner: string | null;
  readonly status: string;
  readonly pauseReason: string | null;
  readonly pausePayloadJson: string | null;
  readonly specJson: string | null;
  readonly argsJson: string | null;
  readonly tokenBudget: number | null;
  readonly tainted: boolean;
  readonly progressJson: string | null;
  readonly auditSegmentId: string | null;
  readonly updatedAt: number;
  readonly fence: number | null;
  readonly holder: string | null;
  readonly now: number;
  readonly requireUnleased?: boolean;
}

export interface CacheCostInput {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

function refuse(
  warning: (warning: StateWarning) => void,
  what: string,
  runId: string,
  fence: number | null,
): false {
  warning({ cause: "STALE_FENCE_WRITE", runId, fence: fence ?? -1 });
  return false;
}

/**
 * THE ownership guard — one shape, one place. Every owned write (state, cache,
 * node-cost, spend, and the combined cache+cost transaction) appends this same
 * suffix to its own statement: exact current fence, current holder, unexpired
 * lease. There is no second copy to drift, and no read-then-write window.
 */
function ownershipGuard(
  runId: string,
  ownership: Ownership,
): { readonly suffix: string; readonly params: readonly unknown[] } {
  return {
    suffix: `
       FROM (SELECT 1 AS dual)
       JOIN workflow_run_fence f ON f.run_id = ? AND f.fence = ?
       JOIN workflow_run_locks l ON l.run_id = ? AND l.holder = ?
         AND l.expires_at > ?`,
    params: [runId, ownership.fence, runId, ownership.holder, ownership.now],
  };
}

function ints(values: readonly number[]): number[] {
  return values.map((value) => {
    const numeric = Math.trunc(value);
    if (!Number.isSafeInteger(numeric)) {
      throw new RangeError(`workflow cost value ${String(value)} is not a safe integer`);
    }
    return numeric;
  });
}

/**
 * The durable run-state store over the six workflow tables the schema already
 * carries (T03). One shared ownership primitive backs every owned write.
 *
 * T16 hardening (registered divergence from the oracle, never normalized):
 * the oracle's fenced writes accept any token >= the current fence and keep
 * landing after release; here an owned write demands, inside the write's own
 * statement, (i) fence EXACTLY equal to the current one, (ii) the current
 * holder of the lease, and (iii) that lease not yet expired. Post-release,
 * post-expiry, wrong-holder, stale and forged tokens are all refused by SQL.
 */
export class WorkflowRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly warning: (warning: StateWarning) => void = () => undefined,
  ) {}

  // --- the durable line (workflow_run_state) --------------------------------

  public putRunState(runId: string, fields: RunStateFields): boolean {
    // Ownerless writes (fence=null, the mark_cancelled path) demand — folded
    // into the SAME statement — that nobody holds a live lease on the run.
    //
    // That ONE condition is the whole guard. An earlier version also demanded
    // `NOT EXISTS (fence > presented)` with a presented token of -1, which can
    // never hold: the fence deliberately survives release, so every run that
    // was ever acquired keeps fence >= 1 and the ownerless write was refused
    // forever. Ownerless means "nobody owns it", not "nobody ever did".
    const unleased = fields.requireUnleased === true;
    if (unleased) {
      const sql = `INSERT OR REPLACE INTO workflow_run_state
         (run_id, name, owner, status, pause_reason, pause_payload_json,
          spec_json, args_json, token_budget, tainted, progress_json,
          audit_segment_id, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM workflow_run_locks WHERE run_id = ? AND expires_at > ?
         )`;
      const values: unknown[] = [
        runId,
        fields.name,
        fields.owner,
        fields.status,
        fields.pauseReason,
        fields.pausePayloadJson,
        fields.specJson,
        fields.argsJson,
        fields.tokenBudget,
        fields.tainted ? 1 : 0,
        fields.progressJson,
        fields.auditSegmentId,
        fields.updatedAt,
        runId,
        fields.now,
      ];
      try {
        const result = this.database.prepare(sql).run(...values);
        if (result.changes > 0) return true;
      } catch (error) {
        if (error instanceof Error && /database is locked/i.test(error.message)) {
          return refuse(this.warning, "run line", runId, fields.fence);
        }
        throw error;
      }
      return refuse(this.warning, "run line", runId, fields.fence);
    }
    // Owned write: the shared live-ownership triple in the write's own
    // statement — the fence=? / holder / expires_at columns of the fields
    // feed the same primitive every other owned write uses.
    return this.ownedWrite(
      `INSERT OR REPLACE INTO workflow_run_state
       (run_id, name, owner, status, pause_reason, pause_payload_json,
        spec_json, args_json, token_budget, tainted, progress_json,
        audit_segment_id, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
      [
        runId,
        fields.name,
        fields.owner,
        fields.status,
        fields.pauseReason,
        fields.pausePayloadJson,
        fields.specJson,
        fields.argsJson,
        fields.tokenBudget,
        fields.tainted ? 1 : 0,
        fields.progressJson,
        fields.auditSegmentId,
        fields.updatedAt,
      ],
      { fence: fields.fence ?? -1, holder: fields.holder ?? "", now: fields.now },
      "run line",
      runId,
    );
  }

  public getRunState(runId: string): Record<string, unknown> | null {
    const row = this.database
      .prepare("SELECT * FROM workflow_run_state WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  public recentRunStates(limit: number): readonly Record<string, unknown>[] {
    return this.database
      .prepare("SELECT * FROM workflow_run_state ORDER BY updated_at DESC LIMIT ?")
      .all(Math.max(0, Math.trunc(limit))) as readonly Record<string, unknown>[];
  }

  public runStatesByPause(
    pauseReason: string,
    limit: number,
  ): readonly Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT * FROM workflow_run_state WHERE status = 'paused' AND pause_reason = ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pauseReason, Math.max(0, Math.trunc(limit))) as readonly Record<
      string,
      unknown
    >[];
  }

  // --- node cache + cost -------------------------------------------------------

  public getCacheCell(
    runId: string,
    hash: string,
  ): { status: string; outputJson: string | null } | null {
    const row = this.database
      .prepare(
        "SELECT status, output_json FROM workflow_node_cache WHERE run_id = ? AND content_hash = ?",
      )
      .get(runId, hash) as { status: string; output_json: string | null } | undefined;
    return row === undefined ? null : { status: row.status, outputJson: row.output_json };
  }

  public putCacheCell(
    runId: string,
    hash: string,
    nodeId: string,
    outputJson: string | null,
    status: string,
    ownership: Ownership,
  ): boolean {
    return this.ownedWrite(
      `INSERT OR REPLACE INTO workflow_node_cache
       (content_hash, run_id, node_id, output_json, status, updated_at)
       SELECT ?, ?, ?, ?, ?, ?`,
      [hash, runId, nodeId, outputJson, status, ownership.now],
      ownership,
      "node cache",
      runId,
    );
  }

  /**
   * The cell AND what it cost, ONE transaction: the cell's INSERT carries the
   * ownership guard; the cost INSERT only runs after that success inside the
   * same transaction. Refused cell → rollback, nothing written ("priced or
   * absent"); a cost failure rolls the cell back too. The DIRECT node-cost
   * write keeps its own guard — see putCacheCost.
   */
  public putCacheCellWithCost(
    runId: string,
    hash: string,
    nodeId: string,
    outputJson: string | null,
    status: string,
    ownership: Ownership,
    cost: CacheCostInput | null,
  ): boolean {
    const guard = ownershipGuard(runId, ownership);
    const cellSql = `INSERT OR REPLACE INTO workflow_node_cache
           (content_hash, run_id, node_id, output_json, status, updated_at)
           SELECT ?, ?, ?, ?, ?, ?`;
    const write = this.database.transaction(() => {
      const cell = this.database
        .prepare(`${cellSql}${guard.suffix}`)
        .run(hash, runId, nodeId, outputJson, status, ownership.now, ...guard.params);
      if (cell.changes === 0) return false;
      if (cost !== null) {
        this.database
          .prepare(
            `INSERT OR REPLACE INTO workflow_node_cost
             (run_id, content_hash, tokens_in, tokens_out, cache_read_tokens,
              cache_write_tokens, reasoning_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            hash,
            ...ints([
              cost.tokensIn,
              cost.tokensOut,
              cost.cacheRead,
              cost.cacheWrite,
              cost.reasoning,
            ]),
          );
      }
      return true;
    });
    try {
      // A refused cell is a refused WRITE: it logs its cause like every other
      // owned write, and the cost half never happened.
      return write.immediate() || refuse(this.warning, "node cache", runId, ownership.fence);
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) {
        return refuse(this.warning, "node cache", runId, ownership.fence);
      }
      throw error;
    }
  }

  public getCacheCost(
    runId: string,
    hash: string,
  ): {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } | null {
    const row = this.database
      .prepare(
        `SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
                reasoning_tokens
         FROM workflow_node_cost WHERE run_id = ? AND content_hash = ?`,
      )
      .get(runId, hash) as
      | {
          readonly tokens_in: bigint;
          readonly tokens_out: bigint;
          readonly cache_read_tokens: bigint | null;
          readonly cache_write_tokens: bigint | null;
          readonly reasoning_tokens: bigint | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      tokensIn: safeInteger(row.tokens_in, "workflow_node_cost.tokens_in"),
      tokensOut: safeInteger(row.tokens_out, "workflow_node_cost.tokens_out"),
      cacheRead:
        row.cache_read_tokens === null ? 0 : safeInteger(row.cache_read_tokens, "cache_read"),
      cacheWrite:
        row.cache_write_tokens === null
          ? 0
          : safeInteger(row.cache_write_tokens, "cache_write"),
      reasoning:
        row.reasoning_tokens === null ? 0 : safeInteger(row.reasoning_tokens, "reasoning"),
    };
  }

  public putCacheCost(
    runId: string,
    hash: string,
    tokensIn: number,
    tokensOut: number,
    cacheRead: number,
    cacheWrite: number,
    reasoning: number,
    ownership: Ownership,
  ): boolean {
    return this.ownedWrite(
      `INSERT OR REPLACE INTO workflow_node_cost
       (run_id, content_hash, tokens_in, tokens_out, cache_read_tokens,
        cache_write_tokens, reasoning_tokens)
       SELECT ?, ?, ?, ?, ?, ?, ?`,
      [runId, hash, ...ints([tokensIn, tokensOut, cacheRead, cacheWrite, reasoning])],
      ownership,
      "cell cost",
      runId,
    );
  }

  public cacheCostTotals(runId: string): { tokensIn: number; tokensOut: number } {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0) AS ti, COALESCE(SUM(tokens_out), 0) AS to_
         FROM workflow_node_cost WHERE run_id = ?`,
      )
      .get(runId) as { readonly ti: bigint; readonly to_: bigint };
    return {
      tokensIn: safeInteger(row.ti, "sum(tokens_in)"),
      tokensOut: safeInteger(row.to_, "sum(tokens_out)"),
    };
  }

  public cacheCostSplit(runId: string): {
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(cache_read_tokens), 0) AS cr,
                COALESCE(SUM(cache_write_tokens), 0) AS cw,
                COALESCE(SUM(reasoning_tokens), 0) AS rt
         FROM workflow_node_cost WHERE run_id = ?`,
      )
      .get(runId) as {
      readonly cr: bigint | null;
      readonly cw: bigint | null;
      readonly rt: bigint | null;
    };
    return {
      cacheRead: row.cr === null ? 0 : safeInteger(row.cr, "split cache_read"),
      cacheWrite: row.cw === null ? 0 : safeInteger(row.cw, "split cache_write"),
      reasoning: row.rt === null ? 0 : safeInteger(row.rt, "split reasoning"),
    };
  }

  // --- run-level token ledger (workflow_run_spend) ------------------------------

  public getRunSpend(runId: string): Record<string, unknown> | null {
    const row = this.database
      .prepare(
        `SELECT token_budget, tokens_in, tokens_out, cache_read_tokens,
                cache_write_tokens, reasoning_tokens
         FROM workflow_run_spend WHERE run_id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  public putRunSpend(
    runId: string,
    tokenBudget: number | null,
    tokensIn: number,
    tokensOut: number,
    cacheRead: number,
    cacheWrite: number,
    reasoning: number,
    ownership: Ownership,
  ): boolean {
    return this.ownedWrite(
      `INSERT OR REPLACE INTO workflow_run_spend
       (run_id, token_budget, tokens_in, tokens_out, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?`,
      [
        runId,
        tokenBudget,
        ...ints([tokensIn, tokensOut, cacheRead, cacheWrite, reasoning]),
        ownership.now,
      ],
      ownership,
      "run ledger",
      runId,
    );
  }

  // --- the single shared ownership primitive --------------------------------------

  private ownedWrite(
    sql: string,
    values: readonly unknown[],
    ownership: Ownership,
    what: string,
    runId: string,
  ): boolean {
    // One primitive, one shape: exact fence + live holder + unexpired lease,
    // appended to the write's own statement (never read-then-write). SQLite
    // needs the JOINs after a FROM-dual source, never directly after SELECT.
    const guard = ownershipGuard(runId, ownership);
    try {
      const result = this.database
        .prepare(`${sql}${guard.suffix}`)
        .run(...values, ...guard.params);
      if (result.changes > 0) return true;
    } catch (error) {
      if (error instanceof Error && /database is locked/i.test(error.message)) {
        return refuse(this.warning, what, runId, ownership.fence);
      }
      throw error;
    }
    return refuse(this.warning, what, runId, ownership.fence);
  }
}
