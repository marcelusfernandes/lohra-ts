import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments, ToolFunctionSchema } from "../tools/types.js";
import { CronStoreError, CronValidationError } from "./errors.js";
import type { CronStore } from "./store.js";

const CRON_GUIDANCE =
  "Schedule prompts to run later as autonomous agent turns. Use for recurring " +
  "or one-off background work the user asked to automate (a daily summary, a " +
  "periodic check). 'interval' value = minutes; 'once' value = an epoch " +
  "timestamp; 'cron' value = a 5-field expression (min hour day month weekday, " +
  "weekday 0=Sunday). Each run is isolated — write a fully self-contained prompt.";

/** Ports tool.py's `_SCHEMA` byte-exact (description, property order, enums, required). */
export const CRON_TOOL_SCHEMA: ToolFunctionSchema = {
  description: CRON_GUIDANCE,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove", "pause", "resume"] },
      name: { type: "string", description: "Job name (for 'add')" },
      prompt: { type: "string", description: "The instruction each run executes (for 'add')" },
      schedule_type: { type: "string", enum: ["once", "interval", "cron"] },
      value: { description: "minutes (interval) | epoch (once) | cron expr (cron)" },
      job_id: { type: "string", description: "Target job (remove/pause/resume)" },
    },
    required: ["action"],
  },
};

type Action = "add" | "list" | "remove" | "pause" | "resume";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarize(job: {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly value: unknown;
  readonly enabled: boolean;
  readonly last_run_at: number | null;
}): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    type: job.type,
    value: job.value,
    enabled: job.enabled,
    last_run_at: job.last_run_at,
  };
}

/** Ports cron/tool.py's CronTool: same store, same envelope shapes, same message text. */
export class CronTool {
  public constructor(private readonly store: CronStore) {}

  public handle(args: ToolArguments): string {
    const action = text(args.action);
    try {
      if (action === "add") return this.add(args);
      if (action === "list") return this.list();
      if (action === "remove" || action === "pause" || action === "resume") {
        return this.target(action, args);
      }
      return toolError(
        `unknown action ${JSON.stringify(action)} (use add/list/remove/pause/resume)`,
      );
    } catch (error) {
      if (error instanceof CronValidationError || error instanceof CronStoreError) {
        return toolError(error.message);
      }
      throw error;
    }
  }

  private add(args: ToolArguments): string {
    const scheduleType = text(args.schedule_type);
    if (!scheduleType) {
      return toolError("'add' requires 'schedule_type' (once/interval/cron)");
    }
    const job = this.store.add({
      name: text(args.name) ?? "",
      prompt: text(args.prompt) ?? "",
      type: scheduleType,
      value: args.value,
    });
    return toolResult(undefined, { job_id: job.id, name: job.name });
  }

  private list(): string {
    const jobs = this.store.list().map(summarize);
    return toolResult(undefined, { jobs });
  }

  private target(
    action: Extract<Action, "remove" | "pause" | "resume">,
    args: ToolArguments,
  ): string {
    const jobId = text(args.job_id);
    if (!jobId) return toolError(`'${action}' requires 'job_id'`);
    const found =
      action === "remove"
        ? this.store.remove(jobId)
        : this.store.setEnabled(jobId, action === "resume");
    if (!found) return toolError(`no job with id ${JSON.stringify(jobId)}`);
    return toolResult(undefined, { job_id: jobId, action });
  }
}
