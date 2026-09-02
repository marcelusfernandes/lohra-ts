import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolHandler } from "../tools/types.js";
import type { WorkflowService } from "./service.js";
import type { AuditRepository } from "../state/audit-repository.js";
import { pythonJsonLoads } from "../serialization/python-json.js";
import { parseAuditQuery } from "./audit-query.js";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export class WorkflowTool {
  constructor(
    private readonly service: WorkflowService,
    private readonly auditRepository?: AuditRepository,
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
    const out = await this.service.status(args.run_id, args.wait === true);
    return "error" in out ? toolError(out.error as string) : toolResult(undefined, out);
  }

  list(): string {
    return toolResult(undefined, { runs: this.service.list() });
  }

  pause(args: ToolArguments): string {
    if (typeof args.run_id !== "string") return toolError("workflow_pause requires 'run_id'");
    const out = this.service.pause(args.run_id);
    return "error" in out ? toolError(String(out.error)) : toolResult(undefined, out);
  }

  cancel(args: ToolArguments): string {
    if (typeof args.run_id !== "string") return toolError("workflow_cancel requires 'run_id'");
    const out = this.service.cancel(args.run_id);
    return "error" in out ? toolError(String(out.error)) : toolResult(undefined, out);
  }

  audit(args: ToolArguments): string {
    const parsed = parseAuditQuery(args);
    if ("error" in parsed) return toolError(parsed.error);
    if (this.auditRepository === undefined) return toolError("workflow audit store is unavailable");
    const page = pythonJsonLoads(
      JSON.stringify(this.auditRepository.query(parsed.query)),
    ) as Readonly<Record<string, unknown>>;
    return toolResult(undefined, page);
  }
}

export function workflowToolHandlers(
  service: WorkflowService,
  auditRepository?: AuditRepository,
): Readonly<Record<string, ToolHandler>> {
  const tool = new WorkflowTool(service, auditRepository);
  return Object.freeze({
    run_workflow: (args) => tool.run(args),
    workflow_status: (args) => tool.status(args),
    workflow_list: () => tool.list(),
    workflow_pause: (args) => tool.pause(args),
    workflow_cancel: (args) => tool.cancel(args),
    workflow_audit: (args) => tool.audit(args),
  });
}
