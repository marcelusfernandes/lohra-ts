import { createHash } from "node:crypto";

export const AUDIT_MODE = "metadata_only" as const;
export const AUDIT_QUEUE_CAPACITY = 256;
export const AUDIT_EVENT_BYTES = 2_048;
export const AUDIT_EVENTS_PER_RUN = 2_048;
export const AUDIT_RUN_CAP = 64;
export const AUDIT_RETENTION_SECONDS = 2_592_000;

export type AuditMarker = Readonly<Record<string, unknown>>;

export interface AuditInput {
  readonly event_type: string;
  readonly provenance?: string;
  readonly segment_id?: string | null;
  readonly node_id?: string | null;
  readonly sub_id?: string | null;
  readonly attempt?: number | null;
  readonly payload?: unknown;
  readonly created_at?: number;
}

export interface PublicAuditEvent extends Readonly<Record<string, unknown>> {
  readonly schema_version: 1;
  readonly event_type: string;
  readonly provenance: string;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly seq: number;
  readonly created_at: number;
}

const RAW_FIELDS = new Set([
  "prompt",
  "response",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "provider_data",
  "encrypted_content",
  "text",
  "content",
  "args",
  "arguments",
  "result",
  "output",
  "command",
  "url",
  "error",
  "message",
  "cause",
  "name",
]);
const PRIVATE_FIELDS = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "provider_data",
  "encrypted_content",
]);
const IDENTITY_FIELDS = new Set(["model", "provider"]);
const OPAQUE_FIELDS = new Set(["tool_id"]);
const NUMBER_FIELDS = new Set([
  "attempt",
  "done",
  "total",
  "characters",
  "bytes",
  "items",
  "fields",
  "original_bytes",
  "limit_bytes",
  "dropped_count",
  "before_seq",
  "seq",
  "created_at",
  "token_budget",
  "tokens_in",
  "tokens_out",
]);
const BOOLEAN_FIELDS = new Set(["tainted", "stale", "terminal"]);
const PATH_FIELDS = new Set(["node_path", "branch_path"]);
const CONTAINER_FIELDS = new Set(["payload", "metadata", "budget", "usage", "progress"]);
const SAFE_MARKER_STATES = new Set([
  "excluded_by_policy",
  "excluded_private_state",
  "not_observed",
  "not_yet_available",
  "observed",
  "redacted",
  "truncated",
  "unavailable",
]);
const SAFE_EVENT_TYPES = new Set([
  "audit.gap",
  "audit.truncated",
  "audit.unavailable",
  "cache.missed",
  "cache.replayed",
  "cache.stored",
  "cache.unavailable",
  "leaf.completed",
  "leaf.failed",
  "leaf.started",
  "node.completed",
  "node.failed",
  "node.output",
  "node.paused",
  "node.started",
  "segment.completed",
  "segment.started",
  "tool.completed",
  "tool.started",
  "workflow.done",
  "workflow.fault",
  "workflow.items",
  "workflow.node",
  "workflow.plan",
]);
const SAFE_PROVENANCE = new Set([
  "dropped",
  "observed",
  "replayed",
  "synthetic",
  "truncated",
  "unavailable",
]);
const SAFE_STRING_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  reason: new Set([
    "corrupt_payload",
    "drop_bucket_overflow",
    "lookup_failed",
    "process_crash",
    "queue_overflow",
    "retention_limit",
    "sink_failure",
    "store_failed",
    "tombstone_compaction",
    "unavailable",
  ]),
  state: new Set([...SAFE_MARKER_STATES, "complete", "fault", "null", "pending", "running"]),
  status: new Set([
    "cancelled",
    "complete",
    "degraded",
    "error",
    "failed",
    "interrupted",
    "paused",
    "success",
    "unavailable",
  ]),
  side: new Set(["depth"]),
  count_state: new Set(["unavailable"]),
  private_state: new Set(["excluded_private_state", "not_observed"]),
  run_attribution: new Set(["unavailable"]),
  source: new Set(["gateway", "harness", "human_checkpoint"]),
  tool_name_state: new Set(["known_tool", "unknown_tool"]),
  unit: new Set(["bytes", "characters", "items", "top_level_items"]),
  original_event_type: SAFE_EVENT_TYPES,
});

function clipped(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function boundedRunId(value: string): string {
  if (Array.from(value).length <= 128) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${clipped(value, 95)}~${digest}`;
}

function rawMarker(value: unknown): AuditMarker {
  if (typeof value === "string")
    return Object.freeze({
      state: "excluded_by_policy",
      characters: Math.min(Array.from(value).length, 256),
    });
  if (value instanceof Uint8Array)
    return Object.freeze({
      state: "excluded_by_policy",
      bytes: value.byteLength,
    });
  if (Array.isArray(value))
    return Object.freeze({ state: "excluded_by_policy", items: Math.min(value.length, 256) });
  if (value !== null && typeof value === "object")
    return Object.freeze({
      state: "excluded_by_policy",
      fields: Math.min(Object.keys(value).length, 256),
    });
  return Object.freeze({ state: "excluded_by_policy" });
}

function marker(value: Readonly<Record<string, unknown>>): AuditMarker | null {
  if (typeof value.state !== "string" || !SAFE_MARKER_STATES.has(value.state)) return null;
  const out: Record<string, unknown> = { state: value.state };
  for (const key of ["characters", "items", "fields"])
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      out[key] = Math.min(256, Math.max(0, Math.trunc(value[key])));
  for (const key of ["bytes", "original_bytes", "limit_bytes"])
    if (typeof value[key] === "number" && Number.isFinite(value[key]))
      out[key] = Math.max(0, Math.trunc(value[key]));
  if (value.side === "depth") out.side = "depth";
  if (
    typeof value.original_event_type === "string" &&
    SAFE_EVENT_TYPES.has(value.original_event_type)
  )
    out.original_event_type = value.original_event_type;
  return Object.freeze(out);
}

function safeValue(value: unknown, key: string, depth: number): unknown {
  if (RAW_FIELDS.has(key)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const preserved = marker(value as Readonly<Record<string, unknown>>);
      if (
        preserved?.state === "excluded_by_policy" ||
        (PRIVATE_FIELDS.has(key) && preserved?.state === "excluded_private_state")
      )
        return preserved;
    }
    return rawMarker(value);
  }
  if (depth >= 4) return Object.freeze({ state: "truncated", side: "depth" });
  if (value === null) return null;
  if (typeof value === "boolean") return BOOLEAN_FIELDS.has(key) ? value : undefined;
  if (typeof value === "number")
    return NUMBER_FIELDS.has(key) && Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (IDENTITY_FIELDS.has(key)) return clipped(value, 128);
    const allowed = SAFE_STRING_VALUES[key];
    if (allowed !== undefined) return allowed.has(value) ? value : rawMarker(value);
    return Object.freeze({
      state: OPAQUE_FIELDS.has(key) ? "observed" : "excluded_by_policy",
      characters: Math.min(Array.from(value).length, 256),
    });
  }
  if (value instanceof Uint8Array)
    return Object.freeze({
      state: "unavailable",
      bytes: value.byteLength,
    });
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    if (key === "node_path")
      return Object.freeze(items.slice(-8).map((item) => clipped(String(item), 64)));
    if (key === "branch_path")
      return Object.freeze(
        items
          .slice(-8)
          .flatMap((item): readonly number[] =>
            typeof item === "number" && Number.isInteger(item) ? [item] : [],
          ),
      );
    if (!PATH_FIELDS.has(key) && !CONTAINER_FIELDS.has(key))
      return Object.freeze({ state: "observed", items: Math.min(items.length, 256) });
    return Object.freeze(items.slice(0, 32).map((item) => safeValue(item, "payload", depth + 1)));
  }
  if (typeof value !== "object") return undefined;
  const source = value as Readonly<Record<string, unknown>>;
  const preserved = marker(source);
  if (preserved !== null) return preserved;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let count = 0;
  for (const [rawKey, child] of Object.entries(source)) {
    if (count >= 16) break;
    const childKey = clipped(rawKey, 64);
    if (
      !RAW_FIELDS.has(childKey) &&
      !IDENTITY_FIELDS.has(childKey) &&
      !NUMBER_FIELDS.has(childKey) &&
      !BOOLEAN_FIELDS.has(childKey) &&
      !PATH_FIELDS.has(childKey) &&
      !CONTAINER_FIELDS.has(childKey) &&
      !OPAQUE_FIELDS.has(childKey) &&
      SAFE_STRING_VALUES[childKey] === undefined
    ) {
      Object.defineProperty(out, childKey, {
        value: rawMarker(child),
        enumerable: true,
      });
      count += 1;
      continue;
    }
    const safe = safeValue(child, childKey, depth + 1);
    if (safe !== undefined) {
      Object.defineProperty(out, childKey, { value: safe, enumerable: true });
      count += 1;
    }
  }
  return Object.freeze(out);
}

export function safeAuditMetadata(value: unknown): Readonly<Record<string, unknown>> {
  const safe = safeValue(value, "metadata", 0);
  return safe !== null && typeof safe === "object" && !Array.isArray(safe)
    ? (safe as Readonly<Record<string, unknown>>)
    : Object.freeze({ state: "unavailable" });
}

function eventBytes(value: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function publicAuditEvent(
  runId: string,
  seq: number,
  input: AuditInput,
  now: number,
): PublicAuditEvent {
  const eventType = SAFE_EVENT_TYPES.has(input.event_type) ? input.event_type : "audit.unavailable";
  const requestedProvenance = input.provenance ?? "observed";
  const provenance = SAFE_PROVENANCE.has(requestedProvenance) ? requestedProvenance : "unavailable";
  const event: PublicAuditEvent = Object.freeze({
    schema_version: 1,
    event_type: eventType,
    provenance,
    identity: publicAuditIdentity(runId, input),
    data: safeAuditMetadata(input.payload ?? {}),
    seq,
    created_at: input.created_at ?? now,
  });
  const bytes = eventBytes(event);
  if (bytes <= AUDIT_EVENT_BYTES) return event;
  return Object.freeze({
    schema_version: 1,
    event_type: "audit.truncated",
    provenance: "truncated",
    identity: Object.freeze({ run_id: boundedRunId(runId) }),
    data: Object.freeze({
      state: "truncated",
      original_bytes: bytes,
      limit_bytes: AUDIT_EVENT_BYTES,
      original_event_type: eventType,
    }),
    seq,
    created_at: input.created_at ?? now,
  });
}

export function publicAuditIdentity(
  runId: string,
  input: Pick<AuditInput, "segment_id" | "node_id" | "sub_id" | "attempt">,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    run_id: boundedRunId(runId),
    ...(input.segment_id === undefined || input.segment_id === null
      ? {}
      : { segment_id: clipped(input.segment_id, 128) }),
    ...(input.node_id === undefined || input.node_id === null
      ? {}
      : { node_path: Object.freeze([clipped(input.node_id, 64)]) }),
    ...(input.sub_id === undefined || input.sub_id === null
      ? {}
      : { sub_id: clipped(input.sub_id, 128) }),
    ...(input.attempt === undefined || input.attempt === null
      ? {}
      : { attempt: Math.max(0, Math.trunc(input.attempt)) }),
  });
}

export const AUDIT_POLICY = Object.freeze({
  mode: AUDIT_MODE,
  raw_payloads: "redacted_or_excluded_at_ingest_and_read",
  private_reasoning: "excluded_private_state",
  provider_calls: "none",
  summary_generated: false,
});

export function auditEnabled(
  environment: Readonly<Record<string, string | undefined>>,
  warning: (message: string) => void = () => undefined,
): boolean {
  const raw = environment.LOHRA_AUDIT?.trim().toLowerCase();
  if (
    raw === undefined ||
    raw === "" ||
    raw === "on" ||
    raw === "1" ||
    raw === "true" ||
    raw === "yes"
  )
    return true;
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  warning(`invalid LOHRA_AUDIT value '${raw}'; audit remains enabled`);
  return true;
}

export function resolveAuditSettings(
  environment: Readonly<Record<string, string | undefined>>,
  warning: (message: string) => void = () => undefined,
): Readonly<{ enabled: boolean; maxEventsPerRun: number }> {
  const raw = environment.LOHRA_AUDIT_MAX_EVENTS?.trim();
  let maxEventsPerRun = AUDIT_EVENTS_PER_RUN;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 1) maxEventsPerRun = parsed;
    else
      warning(
        `ignoring LOHRA_AUDIT_MAX_EVENTS='${raw}': expected an integer >= 1; using ${String(AUDIT_EVENTS_PER_RUN)}`,
      );
  }
  return Object.freeze({
    enabled: auditEnabled(environment, warning),
    maxEventsPerRun,
  });
}
