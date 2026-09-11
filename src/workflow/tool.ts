import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { WorkflowService } from "./service.js";
import type { AuditRepository } from "../state/audit-repository.js";
import { parseJsonPreservingNumbers } from "../serialization/json-numbers.js";
import { parseAuditQuery } from "./audit-query.js";
// Issue #369: `tail` is threaded in by the CALLER (chat.ts/dashboard.ts,
// via a second, narrower `registry.overrideHandlers` after
// `composeSessionTools` — `session-tools.ts:93`'s own `workflowToolHandlers`
// call is outside this issue's Files and stays 2-arg, tail-less).
// `tail.isKnown(runId)` (not `service.list()`, which also lists
// durable-only runs by design — "find a run whose id you lost") is what
// tells `status()` whether `live_tail` means anything: true only for a run
// THIS tail has itself observed a live event for.
import type { WorkflowLiveTail } from "./live-tail.js";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function auditResult(repository: AuditRepository, args: ToolArguments): string {
  const parsed = parseAuditQuery(args);
  if ("error" in parsed) return toolError(parsed.error);
  const page = parseJsonPreservingNumbers(
    JSON.stringify(repository.query(parsed.query)),
  ) as Readonly<Record<string, unknown>>;
  return toolResult(undefined, page);
}

export function workflowAuditHandler(repository: AuditRepository): ToolHandler {
  return (args) => auditResult(repository, args);
}

export class WorkflowTool {
  constructor(
    private readonly service: WorkflowService,
    private readonly auditRepository?: AuditRepository,
    private readonly tail?: WorkflowLiveTail,
  ) {}

  run(args: ToolArguments): string {
    const resumeRunId = args.resume_run_id;
    if (resumeRunId !== undefined && typeof resumeRunId !== "string")
      return toolError("'resume_run_id' must be a string");
    const spec = args.spec;
    if (spec !== undefined && record(spec) === null)
      return toolError("'spec' must be an object (with meta + nodes)");
    if (spec === undefined && resumeRunId === undefined)
      return toolError("run_workflow needs a 'spec' object (with meta + nodes)");
    const runArgs = args.args;
    if (runArgs !== undefined && record(runArgs) === null)
      return toolError("'args' must be an object of run inputs (referenced as ${args.x})");
    const answers = args.checkpoint_answers;
    if (answers !== undefined && record(answers) === null)
      return toolError("'checkpoint_answers' must be an object keyed by checkpoint node id");
    const tokenBudget = args.token_budget;
    if (
      tokenBudget !== undefined &&
      (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget <= 0)
    )
      return toolError("'token_budget' must be a positive integer");
    const out = this.service.start(spec === undefined ? null : spec, record(runArgs) ?? {}, {
      ...(answers === undefined ? {} : { checkpointAnswers: record(answers) ?? {} }),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(resumeRunId === undefined ? {} : { resumeRunId }),
    });
    if ("error" in out)
      return out.invalid_spec === true
        ? toolError(`invalid workflow spec: ${out.error}`)
        : toolError(out.error);
    return toolResult(undefined, { ...out });
  }

  async status(args: ToolArguments): Promise<string> {
    if (typeof args.run_id !== "string") return toolError("workflow_status requires 'run_id'");
    const afterIndexArg = args.after_index;
    let afterIndex = 0;
    if (afterIndexArg !== undefined) {
      if (
        typeof afterIndexArg !== "number" ||
        !Number.isInteger(afterIndexArg) ||
        afterIndexArg < 0
      )
        return toolError("'after_index' must be a non-negative integer");
      afterIndex = afterIndexArg;
    }
    const out = await this.service.status(args.run_id, args.wait === true);
    if ("error" in out) return toolError(out.error as string);
    if (this.tail === undefined || !this.tail.isKnown(args.run_id))
      return toolResult(undefined, out);
    const snap = this.tail.snapshot(args.run_id, afterIndex);
    return toolResult(undefined, {
      ...out,
      live_tail: { events: snap.events, next_cursor: snap.next, dropped: snap.dropped },
    });
  }

  list(): string {
    return toolResult(undefined, { runs: this.service.list() });
  }

  pause(args: ToolArguments): string {
    if (typeof args.run_id !== "string") return toolError("workflow_pause requires 'run_id'");
    const out = this.service.pause(args.run_id);
    return "error" in out ? toolError(String(out.error)) : toolResult(undefined, out);
  }

  async cancel(args: ToolArguments): Promise<string> {
    if (typeof args.run_id !== "string") return toolError("workflow_cancel requires 'run_id'");
    const out = await this.service.cancel(args.run_id);
    return "error" in out ? toolError(String(out.error)) : toolResult(undefined, out);
  }

  audit(args: ToolArguments): string {
    if (this.auditRepository === undefined) return toolError("workflow audit store is unavailable");
    return auditResult(this.auditRepository, args);
  }
}

export function workflowToolHandlers(
  service: WorkflowService,
  auditRepository?: AuditRepository,
  tail?: WorkflowLiveTail,
): Readonly<Record<string, ToolHandler>> {
  const tool = new WorkflowTool(service, auditRepository, tail);
  return Object.freeze({
    run_workflow: (args) => tool.run(args),
    workflow_status: (args) => tool.status(args),
    workflow_list: () => tool.list(),
    workflow_pause: (args) => tool.pause(args),
    workflow_cancel: (args) => tool.cancel(args),
    workflow_audit: (args) => tool.audit(args),
  });
}

/** Built for `chat.ts`/`dashboard.ts`'s own composition root: a SECOND,
 * narrower `registry.overrideHandlers({ workflow_status })` right after
 * `composeSessionTools` returns — `session-tools.ts:93`'s `workflowToolHandlers`
 * call (outside this issue's Files) stays 2-arg and tail-less; this is the
 * one path that actually threads the tail into the tool surface. */
export function workflowStatusHandler(
  service: WorkflowService,
  tail: WorkflowLiveTail,
): ToolHandler {
  const tool = new WorkflowTool(service, undefined, tail);
  return (args) => tool.status(args);
}
