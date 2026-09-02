import type { ToolArguments } from "../tools/types.js";
import type { AuditQuery } from "../state/audit-repository.js";

export type AuditQueryResult = { readonly query: AuditQuery } | { readonly error: string };

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^[+-]?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : undefined;
}

export function parseAuditQuery(args: ToolArguments): AuditQueryResult {
  if (typeof args.run_id !== "string" || args.run_id === "")
    return Object.freeze({ error: "workflow_audit requires 'run_id'" });
  const after = args.after_seq === undefined ? 0 : integer(args.after_seq);
  const snapshot = args.snapshot_seq === undefined ? undefined : integer(args.snapshot_seq);
  const attempt = args.attempt === undefined ? undefined : integer(args.attempt);
  const limit = args.limit === undefined ? 50 : integer(args.limit);
  if (after === undefined || after < 0 || (snapshot !== undefined && snapshot < 0))
    return Object.freeze({ error: "audit cursors must be >= 0" });
  if (limit === undefined || limit < 1 || (attempt !== undefined && attempt < 0))
    return Object.freeze({ error: "audit limit must be >= 1 and attempt >= 0" });
  for (const key of ["node_id", "event_type", "sub_id", "segment_id"] as const)
    if (args[key] !== undefined && typeof args[key] !== "string")
      return Object.freeze({ error: `audit ${key} must be a string` });
  return Object.freeze({
    query: Object.freeze({
      runId: args.run_id,
      afterSeq: after,
      limit,
      ...(snapshot === undefined ? {} : { snapshotSeq: snapshot }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(typeof args.node_id === "string" ? { nodeId: args.node_id } : {}),
      ...(typeof args.event_type === "string" ? { eventType: args.event_type } : {}),
      ...(typeof args.sub_id === "string" ? { subId: args.sub_id } : {}),
      ...(typeof args.segment_id === "string" ? { segmentId: args.segment_id } : {}),
    }),
  });
}
