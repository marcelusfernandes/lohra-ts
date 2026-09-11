// Issue #402 (M8-6): the `workflow_notices`/`workflow_notices_ack` TOOL
// surface over `NoticesRepository` (issue #400, `src/state/notices-repository.ts`)
// — deliberately NOT in `tool.ts` (that module is `WorkflowTool`, the
// `run_workflow`/`workflow_status`/... family; notices is its own small
// surface, same reason `workflowAuditHandler` sits ALONGSIDE `WorkflowTool`
// in `tool.ts` rather than inside the class).
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { NoticesListQuery, NoticesRepository } from "../state/notices-repository.js";

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Same idiom as `audit-query.ts`'s `integer()`: accepts a JSON number OR a
 * numeric string (a strict-schema caller sometimes stringifies), never
 * silently coerces anything else. */
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^[+-]?\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : undefined;
}

export type NoticesQueryResult = { readonly query: NoticesListQuery } | { readonly error: string };

/** An empty string for `run_id`, or 0 for `limit`, means absence — the same
 * `""`/`0`-as-absence idiom `workflow_audit` has followed since #390, for a
 * strict-schema caller (Codex `strict: true`) that fills every optional
 * field instead of omitting it. `after_seq` has no such special case: 0 is
 * already its real default ("from the start"), not a value indistinguishable
 * from absence. */
export function parseNoticesQuery(args: ToolArguments): NoticesQueryResult {
  if (args.run_id !== undefined && typeof args.run_id !== "string")
    return Object.freeze({ error: "workflow_notices run_id must be a string" });
  const after = args.after_seq === undefined ? 0 : integer(args.after_seq);
  if (after === undefined || after < 0)
    return Object.freeze({ error: "workflow_notices after_seq must be >= 0" });
  const limitRaw = args.limit === undefined ? undefined : integer(args.limit);
  if (args.limit !== undefined && limitRaw === undefined)
    return Object.freeze({ error: "workflow_notices limit must be an integer" });
  const limit = limitRaw === 0 ? undefined : limitRaw;
  if (limit !== undefined && limit < 1)
    return Object.freeze({ error: "workflow_notices limit must be >= 1" });
  return Object.freeze({
    query: Object.freeze({
      ...(hasText(args.run_id) ? { scope: `run:${args.run_id}` } : {}),
      afterSeq: after,
      includeAcked: args.include_acked === true,
      ...(limit === undefined ? {} : { limit }),
    }),
  });
}

export function workflowNoticesHandler(repository: NoticesRepository): ToolHandler {
  return (args) => {
    const parsed = parseNoticesQuery(args);
    if ("error" in parsed) return toolError(parsed.error);
    const page = repository.list(parsed.query);
    return toolResult(undefined, { ...page, integrity: { refused_writes: page.refused_writes } });
  };
}

export function workflowNoticesAckHandler(repository: NoticesRepository): ToolHandler {
  return (args) => {
    const id = args.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0)
      return toolError("workflow_notices_ack requires a positive integer 'id'");
    const acked = repository.ack(id, "assistant");
    return toolResult(undefined, { acked });
  };
}
