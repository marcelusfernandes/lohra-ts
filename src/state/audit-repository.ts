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
  readonly run_id: string;
  readonly availability: "available" | "unavailable";
  readonly filters: Readonly<Record<string, unknown>>;
  readonly events: readonly PublicAuditEvent[];
  readonly page: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly integrity: Readonly<Record<string, unknown>>;
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
  const seq = rowNumber(row.seq);
  const createdAt = Number(row.created_at);
  try {
    const stored = JSON.parse(String(row.payload_json)) as unknown;
    if (stored === null || typeof stored !== "object" || Array.isArray(stored))
      throw new Error("audit payload is not an object");
    const record = stored as Readonly<Record<string, unknown>>;
    return publicAuditEvent(
      String(row.run_id),
      seq,
      {
        event_type: String(row.event_type),
        provenance: String(row.provenance),
        ...(typeof row.segment_id === "string" ? { segment_id: row.segment_id } : {}),
        ...(typeof row.node_id === "string" ? { node_id: row.node_id } : {}),
        ...(typeof row.sub_id === "string" ? { sub_id: row.sub_id } : {}),
        ...(row.attempt === null || row.attempt === undefined
          ? {}
          : { attempt: rowNumber(row.attempt) }),
        payload: record.data,
        created_at: createdAt,
      },
      createdAt,
    );
  } catch {
    return Object.freeze({
      schema_version: 1,
      event_type: "audit.unavailable",
      provenance: "unavailable",
      identity: Object.freeze({ run_id: String(row.run_id) }),
      data: Object.freeze({ reason: "corrupt_payload" }),
      seq,
      created_at: createdAt,
    });
  }
}

const MARKER_TYPES = new Set(["audit.gap", "audit.truncated", "audit.unavailable"]);
const FIELD_STATE_NAMES = Object.freeze([
  "redacted",
  "truncated",
  "unavailable",
  "excluded_by_policy",
  "excluded_private_state",
] as const);
const FIELD_STATES = new Set<string>(FIELD_STATE_NAMES);

function fieldMarkerCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      [...FIELD_STATE_NAMES]
        .sort((left, right) => left.localeCompare(right))
        .map((state) => [state, counts.get(state) ?? 0]),
    ),
  );
}

function matches(event: PublicAuditEvent, query: AuditQuery): boolean {
  const identity = event.identity;
  const nodePath = Array.isArray(identity.node_path) ? identity.node_path : [];
  return (
    (query.nodeId === undefined || nodePath.includes(query.nodeId)) &&
    (query.eventType === undefined || event.event_type === query.eventType) &&
    (query.subId === undefined || identity.sub_id === query.subId) &&
    (query.segmentId === undefined || identity.segment_id === query.segmentId) &&
    (query.attempt === undefined || identity.attempt === query.attempt)
  );
}

function countStates(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) countStates(item, counts);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.state === "string" && FIELD_STATES.has(record.state))
    counts.set(record.state, (counts.get(record.state) ?? 0) + 1);
  for (const item of Object.values(record)) countStates(item, counts);
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
            input.segment_id ?? null,
            input.node_id ?? null,
            input.sub_id ?? null,
            input.attempt ?? null,
            event.event_type,
            event.provenance,
            JSON.stringify({
              schema_version: event.schema_version,
              event_type: event.event_type,
              provenance: event.provenance,
              identity: event.identity,
              data: event.data,
            }),
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
    const requestedLimit = Math.trunc(query.limit ?? 50);
    const limit = Math.min(100, Math.max(1, requestedLimit));
    const frozen = this.database
      .transaction(() => {
        const state = this.database
          .prepare("SELECT * FROM workflow_audit_state WHERE run_id = ?")
          .get(query.runId) as Readonly<Record<string, unknown>> | undefined;
        const tombstone =
          state === undefined
            ? (this.database
                .prepare("SELECT * FROM workflow_audit_tombstones WHERE run_id = ?")
                .get(query.runId) as Readonly<Record<string, unknown>> | undefined)
            : undefined;
        const rows = this.database
          .prepare("SELECT * FROM workflow_audit_events WHERE run_id=? ORDER BY seq")
          .all(query.runId) as readonly Readonly<Record<string, unknown>>[];
        return Object.freeze({ state, tombstone, rows });
      })
      .deferred();
    const { state, tombstone } = frozen;
    const decoded = frozen.rows.map(parseEvent);
    const currentHigh = decoded.reduce((high, event) => Math.max(high, event.seq), 0);
    const snapshot = Math.min(
      currentHigh,
      Math.max(0, Math.trunc(query.snapshotSeq ?? currentHigh)),
    );
    const filtersEnvelope = Object.freeze(
      Object.fromEntries(
        [
          ["node_id", query.nodeId],
          ["event_type", query.eventType],
          ["sub_id", query.subId],
          ["segment_id", query.segmentId],
          ["attempt", query.attempt],
        ].filter((entry): entry is [string, string | number] => entry[1] !== undefined),
      ),
    );
    if (state === undefined && tombstone === undefined) {
      return Object.freeze({
        run_id: query.runId,
        availability: "unavailable" as const,
        filters: filtersEnvelope,
        events: Object.freeze([]),
        page: Object.freeze({
          after_seq: after,
          next_after_seq: after,
          snapshot_seq: snapshot,
          limit_requested: requestedLimit,
          limit_effective: limit,
          limit_clamped: requestedLimit !== limit,
          returned: 0,
          has_more: false,
        }),
        policy: AUDIT_POLICY,
        integrity: Object.freeze({
          scope: "retained_snapshot",
          event_markers: Object.freeze({ gaps: 0, truncated: 0, unavailable: 1 }),
          field_markers: fieldMarkerCounts(new Map()),
          pagination_truncated: false,
          notices: Object.freeze([
            Object.freeze({
              event_type: "audit.unavailable",
              provenance: "unavailable",
              data: Object.freeze({ reason: "not_recorded" }),
            }),
          ]),
          notices_total: 1,
          notices_returned: 1,
          notices_truncated: false,
        }),
      });
    }
    const snapshotEvents = decoded.filter((event) => event.seq <= snapshot);
    const eligible = snapshotEvents.filter((event) => event.seq > after && matches(event, query));
    const events = eligible.slice(0, limit);
    const notices: Readonly<Record<string, unknown>>[] = snapshotEvents.filter((event) =>
      MARKER_TYPES.has(event.event_type),
    );
    const dropped = rowNumber(state?.retention_dropped);
    if (dropped > 0)
      notices.push(
        Object.freeze({
          event_type: "audit.gap",
          provenance: "dropped",
          data: Object.freeze({
            reason: "retention_limit",
            dropped_count: dropped,
            before_seq: rowNumber(state?.dropped_before_seq),
          }),
        }),
      );
    if (state === undefined && tombstone !== undefined)
      notices.push(
        Object.freeze({
          event_type: "audit.unavailable",
          provenance: "unavailable",
          data: Object.freeze({
            reason: String(tombstone.reason),
          }),
        }),
      );
    const fieldCounts = new Map<string, number>();
    const eventCounts = new Map<string, number>();
    for (const event of snapshotEvents) {
      countStates(event, fieldCounts);
      if (MARKER_TYPES.has(event.event_type))
        eventCounts.set(event.event_type, (eventCounts.get(event.event_type) ?? 0) + 1);
    }
    for (const notice of notices)
      if (!("seq" in notice) && typeof notice.event_type === "string")
        eventCounts.set(notice.event_type, (eventCounts.get(notice.event_type) ?? 0) + 1);
    const next = events.at(-1)?.seq ?? after;
    const returnedNotices = notices.slice(0, 20);
    return Object.freeze({
      run_id: query.runId,
      availability: state !== undefined || decoded.length > 0 ? "available" : "unavailable",
      filters: filtersEnvelope,
      events: Object.freeze(events),
      page: Object.freeze({
        after_seq: after,
        next_after_seq: next,
        snapshot_seq: snapshot,
        limit_requested: requestedLimit,
        limit_effective: limit,
        limit_clamped: requestedLimit !== limit,
        returned: events.length,
        has_more: eligible.length > limit,
      }),
      policy: AUDIT_POLICY,
      integrity: Object.freeze({
        scope: "retained_snapshot",
        event_markers: Object.freeze({
          gaps: eventCounts.get("audit.gap") ?? 0,
          truncated: eventCounts.get("audit.truncated") ?? 0,
          unavailable: eventCounts.get("audit.unavailable") ?? 0,
        }),
        field_markers: fieldMarkerCounts(fieldCounts),
        pagination_truncated: eligible.length > limit,
        notices: Object.freeze(returnedNotices),
        notices_total: notices.length,
        notices_returned: returnedNotices.length,
        notices_truncated: notices.length > returnedNotices.length,
      }),
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
