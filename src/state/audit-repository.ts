import type Database from "better-sqlite3";

import {
  AUDIT_EVENTS_PER_RUN,
  AUDIT_POLICY,
  AUDIT_RETENTION_SECONDS,
  AUDIT_RUN_CAP,
  publicAuditEvent,
  type AuditInput,
  type PublicAuditEvent,
} from "../workflow/audit-model.js";
import type { Ownership } from "./workflow-repository.js";

export interface AuditQuery {
  readonly runId: string;
  readonly nodeId?: string;
  readonly eventType?: string;
  readonly subId?: string;
  readonly segmentId?: string;
  readonly attempt?: number;
  readonly afterSeq?: number;
  readonly snapshotSeq?: number;
  readonly limit?: number;
}

export interface AuditPage extends Readonly<Record<string, unknown>> {
  readonly availability: "available" | "unavailable";
  readonly events: readonly PublicAuditEvent[];
  readonly notices: readonly Readonly<Record<string, unknown>>[];
  readonly after_seq: number;
  readonly next_after_seq: number;
  readonly snapshot_seq: number;
  readonly returned: number;
  readonly has_more: boolean;
}

export interface AuditRepositoryOptions {
  readonly maxEventsPerRun?: number;
  readonly maxRuns?: number;
  readonly maxTombstones?: number;
  readonly retentionSeconds?: number;
  readonly warning?: (message: string) => void;
}

function rowNumber(value: unknown): number {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function parseEvent(row: Readonly<Record<string, unknown>>): PublicAuditEvent {
  const payload = JSON.parse(String(row.payload_json)) as unknown;
  return Object.freeze({
    run_id: String(row.run_id),
    seq: rowNumber(row.seq),
    event_type: String(row.event_type),
    provenance: String(row.provenance),
    ...(typeof row.segment_id === "string" ? { segment_id: row.segment_id } : {}),
    ...(typeof row.node_id === "string" ? { node_id: row.node_id } : {}),
    ...(typeof row.sub_id === "string" ? { sub_id: row.sub_id } : {}),
    ...(row.attempt === null || row.attempt === undefined
      ? {}
      : { attempt: rowNumber(row.attempt) }),
    payload,
    created_at: Number(row.created_at),
  });
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

export class AuditRepository {
  private readonly maxEvents: number;
  private readonly maxRuns: number;
  private readonly maxTombstones: number;
  private readonly retention: number;
  private readonly warning: (message: string) => void;

  public constructor(
    private readonly database: Database.Database,
    options: AuditRepositoryOptions = {},
  ) {
    this.maxEvents = Math.max(1, Math.trunc(options.maxEventsPerRun ?? AUDIT_EVENTS_PER_RUN));
    this.maxRuns = Math.max(1, Math.trunc(options.maxRuns ?? AUDIT_RUN_CAP));
    this.maxTombstones = Math.max(1, Math.trunc(options.maxTombstones ?? AUDIT_RUN_CAP));
    this.retention = Math.max(1, Math.trunc(options.retentionSeconds ?? AUDIT_RETENTION_SECONDS));
    this.warning = options.warning ?? (() => undefined);
  }

  public append(runId: string, input: AuditInput, ownership?: Ownership): PublicAuditEvent | null {
    const now = input.created_at ?? Date.now() / 1_000;
    const transact = this.database
      .transaction((): PublicAuditEvent | null => {
        if (ownership !== undefined) {
          const owned = this.database
            .prepare(
              `SELECT 1 AS ok FROM workflow_run_fence f
           JOIN workflow_run_locks l ON l.run_id = f.run_id
           WHERE f.run_id = ? AND f.fence = ? AND l.holder = ? AND l.expires_at > ?`,
            )
            .get(runId, ownership.fence, ownership.holder, ownership.now);
          if (owned === undefined) return null;
        }
        this.compact(now);
        const prior = this.database
          .prepare("SELECT * FROM workflow_audit_state WHERE run_id = ?")
          .get(runId) as Readonly<Record<string, unknown>> | undefined;
        const tombstone =
          prior === undefined
            ? (this.database
                .prepare("SELECT * FROM workflow_audit_tombstones WHERE run_id = ?")
                .get(runId) as Readonly<Record<string, unknown>> | undefined)
            : undefined;
        const seq =
          prior === undefined
            ? Math.max(1, rowNumber(tombstone?.next_seq))
            : Math.max(1, rowNumber(prior.next_seq));
        const touch = rowNumber(
          (
            this.database
              .prepare(
                "UPDATE workflow_audit_order SET next_value = next_value + 1 WHERE singleton = 1 RETURNING next_value - 1 AS value",
              )
              .get() as Readonly<Record<string, unknown>>
          ).value,
        );
        if (prior === undefined) {
          const lost = tombstone === undefined ? 0 : Math.max(1, seq - 1);
          this.database
            .prepare(
              `INSERT INTO workflow_audit_state
           (run_id,next_seq,touch_order,retained_events,retention_dropped,dropped_before_seq,updated_at)
           VALUES (?,?,?,?,?,?,?)`,
            )
            .run(runId, seq + 1, touch, 1, lost, lost > 0 ? seq : null, now);
          this.database
            .prepare("DELETE FROM workflow_audit_tombstones WHERE run_id = ?")
            .run(runId);
        } else {
          this.database
            .prepare(
              `UPDATE workflow_audit_state SET next_seq=?,touch_order=?,retained_events=retained_events+1,updated_at=?
           WHERE run_id=?`,
            )
            .run(seq + 1, touch, now, runId);
        }
        const event = publicAuditEvent(runId, seq, input, now);
        this.database
          .prepare(
            `INSERT INTO workflow_audit_events
            (run_id,seq,segment_id,node_id,sub_id,attempt,event_type,provenance,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            runId,
            seq,
            event.segment_id ?? null,
            event.node_id ?? null,
            event.sub_id ?? null,
            event.attempt ?? null,
            event.event_type,
            event.provenance,
            JSON.stringify(event.payload),
            event.created_at,
          );
        this.pruneRun(runId);
        this.pruneRuns(now);
        return event;
      })
      .immediate();
    if (transact === null && ownership !== undefined) {
      this.warning(`STALE_FENCE_WRITE audit run=${runId} fence=${String(ownership.fence)}`);
    }
    return transact;
  }

  public query(query: AuditQuery): AuditPage {
    const after = Math.max(0, Math.trunc(query.afterSeq ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 50)));
    const state = this.database
      .prepare("SELECT * FROM workflow_audit_state WHERE run_id = ?")
      .get(query.runId) as Readonly<Record<string, unknown>> | undefined;
    const tombstone =
      state === undefined
        ? this.database
            .prepare("SELECT * FROM workflow_audit_tombstones WHERE run_id = ?")
            .get(query.runId)
        : undefined;
    if (state === undefined && tombstone === undefined) {
      return Object.freeze({
        ...AUDIT_POLICY,
        availability: "unavailable" as const,
        events: Object.freeze([]),
        notices: Object.freeze([
          Object.freeze({ event_type: "audit.unavailable", reason: "not_recorded" }),
        ]),
        after_seq: after,
        next_after_seq: after,
        snapshot_seq: query.snapshotSeq ?? 0,
        returned: 0,
        has_more: false,
      });
    }
    const high = Math.max(
      0,
      rowNumber(state?.next_seq) - 1,
      rowNumber((tombstone as Readonly<Record<string, unknown>> | undefined)?.next_seq) - 1,
    );
    const snapshot = Math.min(high, Math.max(0, Math.trunc(query.snapshotSeq ?? high)));
    const clauses = ["run_id = ?", "seq > ?", "seq <= ?"];
    const values: unknown[] = [query.runId, after, snapshot];
    const filters: readonly [string, unknown][] = [
      ["node_id", query.nodeId],
      ["event_type", query.eventType],
      ["sub_id", query.subId],
      ["segment_id", query.segmentId],
    ];
    for (const [column, value] of filters)
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    if (query.attempt !== undefined) {
      clauses.push("attempt = ?");
      values.push(query.attempt);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM workflow_audit_events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`,
      )
      .all(...values, limit + 1) as readonly Readonly<Record<string, unknown>>[];
    const events = rows.slice(0, limit).map(parseEvent);
    const notices: Readonly<Record<string, unknown>>[] = [];
    const dropped = rowNumber(state?.retention_dropped);
    if (dropped > 0)
      notices.push(
        Object.freeze({
          event_type: "audit.gap",
          reason: "retention_limit",
          dropped_count: dropped,
          before_seq: rowNumber(state?.dropped_before_seq),
        }),
      );
    const next = events.at(-1)?.seq ?? after;
    return Object.freeze({
      ...AUDIT_POLICY,
      availability: "available" as const,
      events: Object.freeze(events),
      notices: Object.freeze(notices),
      after_seq: after,
      next_after_seq: next,
      snapshot_seq: snapshot,
      returned: events.length,
      has_more: rows.length > limit,
    });
  }

  public isBusyError(error: unknown): boolean {
    return isBusy(error);
  }

  private pruneRun(runId: string): void {
    const row = this.database
      .prepare("SELECT count(*) AS count FROM workflow_audit_events WHERE run_id = ?")
      .get(runId) as { count: bigint };
    const overflow = Number(row.count) - this.maxEvents;
    if (overflow <= 0) return;
    const keep = this.database
      .prepare("SELECT seq FROM workflow_audit_events WHERE run_id=? ORDER BY seq LIMIT 1 OFFSET ?")
      .get(runId, overflow) as { seq: bigint };
    const before = Number(keep.seq);
    this.database
      .prepare("DELETE FROM workflow_audit_events WHERE run_id=? AND seq < ?")
      .run(runId, before);
    this.database
      .prepare(
        `UPDATE workflow_audit_state SET retained_events=?,
       retention_dropped=retention_dropped+?, dropped_before_seq=? WHERE run_id=?`,
      )
      .run(this.maxEvents, overflow, before, runId);
  }

  private pruneRuns(now: number): void {
    const rows = this.database
      .prepare(
        "SELECT run_id,next_seq,updated_at FROM workflow_audit_state ORDER BY touch_order DESC",
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    for (const row of rows.slice(this.maxRuns)) {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO workflow_audit_tombstones(run_id,reason,next_seq,evicted_at)
         VALUES (?,?,?,?)`,
        )
        .run(row.run_id, "run_limit", row.next_seq, now);
      this.database.prepare("DELETE FROM workflow_audit_events WHERE run_id=?").run(row.run_id);
      this.database.prepare("DELETE FROM workflow_audit_state WHERE run_id=?").run(row.run_id);
    }
    const tombstones = this.database
      .prepare("SELECT run_id FROM workflow_audit_tombstones ORDER BY evicted_at DESC, run_id DESC")
      .all() as readonly { run_id: string }[];
    for (const row of tombstones.slice(this.maxTombstones))
      this.database.prepare("DELETE FROM workflow_audit_tombstones WHERE run_id=?").run(row.run_id);
  }

  private compact(now: number): void {
    const horizon = now - this.retention;
    const expired = this.database
      .prepare("SELECT run_id,next_seq FROM workflow_audit_state WHERE updated_at < ?")
      .all(horizon) as readonly Readonly<Record<string, unknown>>[];
    for (const row of expired) {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO workflow_audit_tombstones(run_id,reason,next_seq,evicted_at)
         VALUES (?,?,?,?)`,
        )
        .run(row.run_id, "retention_time", row.next_seq, now);
      this.database.prepare("DELETE FROM workflow_audit_events WHERE run_id=?").run(row.run_id);
      this.database.prepare("DELETE FROM workflow_audit_state WHERE run_id=?").run(row.run_id);
    }
    this.database
      .prepare("DELETE FROM workflow_audit_tombstones WHERE evicted_at < ?")
      .run(horizon);
  }
}
