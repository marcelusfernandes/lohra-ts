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
  readonly run_id: string;
  readonly seq: number;
  readonly event_type: string;
  readonly provenance: string;
  readonly payload: unknown;
  readonly created_at: number;
}

const RAW_FIELDS = new Set(["prompt", "response", "reasoning", "content", "arguments", "result"]);
const IDENTITY_FIELDS = new Set([
  "run_id",
  "segment_id",
  "node_id",
  "sub_id",
  "event_type",
  "provenance",
  "identity",
  "model",
  "provider",
  "status",
  "state",
  "reason",
  "side",
  "original_event_type",
  "cause",
  "name",
]);
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

function clipped(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function rawMarker(value: unknown): AuditMarker {
  if (typeof value === "string")
    return Object.freeze({
      state: "excluded_by_policy",
      characters: Math.min(Array.from(value).length, 256),
    });
  if (value instanceof Uint8Array)
    return Object.freeze({ state: "unavailable", bytes: value.byteLength });
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
  if (value.state === "excluded_private_state")
    return Object.freeze({ state: "excluded_private_state" });
  if (value.state === "excluded_by_policy") {
    const out: Record<string, unknown> = { state: "excluded_by_policy" };
    for (const key of ["characters", "bytes", "items", "fields"])
      if (typeof value[key] === "number" && Number.isFinite(value[key]))
        out[key] = Math.min(256, Math.max(0, Math.trunc(value[key])));
    return Object.freeze(out);
  }
  return null;
}

function safeValue(value: unknown, key: string, depth: number): unknown {
  if (RAW_FIELDS.has(key)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const preserved = marker(value as Readonly<Record<string, unknown>>);
      if (preserved !== null) return preserved;
    }
    return rawMarker(value);
  }
  if (depth >= 4) return Object.freeze({ state: "truncated", side: "depth" });
  if (value === null) return null;
  if (typeof value === "boolean") return BOOLEAN_FIELDS.has(key) ? value : undefined;
  if (typeof value === "number")
    return NUMBER_FIELDS.has(key) && Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (IDENTITY_FIELDS.has(key))
      return clipped(value, key === "model" || key === "provider" || key === "identity" ? 128 : 64);
    return Object.freeze({
      state: "observed",
      characters: Math.min(Array.from(value).length, 256),
    });
  }
  if (value instanceof Uint8Array)
    return Object.freeze({ state: "unavailable", bytes: value.byteLength });
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
      !CONTAINER_FIELDS.has(childKey)
    )
      continue;
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
  const event: PublicAuditEvent = Object.freeze({
    run_id: clipped(runId, 128),
    seq,
    event_type: clipped(input.event_type, 64),
    provenance: clipped(input.provenance ?? "workflow", 64),
    ...(input.segment_id === undefined || input.segment_id === null
      ? {}
      : { segment_id: clipped(input.segment_id, 128) }),
    ...(input.node_id === undefined || input.node_id === null
      ? {}
      : { node_id: clipped(input.node_id, 64) }),
    ...(input.sub_id === undefined || input.sub_id === null
      ? {}
      : { sub_id: clipped(input.sub_id, 128) }),
    ...(input.attempt === undefined || input.attempt === null
      ? {}
      : { attempt: Math.max(0, Math.trunc(input.attempt)) }),
    payload: safeAuditMetadata(input.payload ?? {}),
    created_at: input.created_at ?? now,
  });
  const bytes = eventBytes(event);
  if (bytes <= AUDIT_EVENT_BYTES) return event;
  return Object.freeze({
    run_id: clipped(runId, 128),
    seq,
    event_type: "audit.truncated",
    provenance: "audit",
    payload: Object.freeze({
      original_bytes: bytes,
      limit_bytes: AUDIT_EVENT_BYTES,
      original_event_type: clipped(input.event_type, 64),
    }),
    created_at: input.created_at ?? now,
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
  if (raw === undefined || raw === "" || raw === "on" || raw === "1" || raw === "true") return true;
  if (raw === "off" || raw === "0" || raw === "false") return false;
  warning(`invalid LOHRA_AUDIT value '${raw}'; audit remains enabled`);
  return true;
}
