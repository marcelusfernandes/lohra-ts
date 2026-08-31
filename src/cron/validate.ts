import { pythonRepr } from "../serialization/python-repr.js";
import { CronValidationError } from "./errors.js";
import { cronMatches } from "./schedule.js";

const JOB_TYPES = ["once", "interval", "cron"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Ports `store.py`'s `_validate`. Message text is byte-exact against the oracle (decision 12) —
 * do not reword. `--at nan`/`--at inf`/`--at -1` deliberately pass here: `isinstance(x, float)`
 * is true for NaN in Python, and `NaN <= 0` is false, so nothing here rejects them — the ghost-job
 * vector (R5) is reproduced, not blocked, at this layer.
 */
export function validateJob(
  name: string,
  prompt: string,
  jobType: string,
  value: unknown,
): asserts jobType is JobType {
  if (!name || !name.trim()) throw new CronValidationError("a job needs a non-empty 'name'");
  if (!prompt || !prompt.trim()) {
    throw new CronValidationError("a job needs a non-empty 'prompt'");
  }
  if (!(JOB_TYPES as readonly string[]).includes(jobType)) {
    throw new CronValidationError(
      `unknown job type ${pythonRepr(jobType)} (use once/interval/cron)`,
    );
  }
  if (jobType === "interval") {
    if (typeof value !== "number" || value <= 0) {
      throw new CronValidationError("'interval' value must be minutes > 0");
    }
  } else if (jobType === "once") {
    if (typeof value !== "number") {
      throw new CronValidationError("'once' value must be a run-at epoch timestamp");
    }
  } else if (jobType === "cron") {
    try {
      cronMatches(String(value), new Date(0));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CronValidationError(`invalid cron expression: ${message}`);
    }
  }
}
