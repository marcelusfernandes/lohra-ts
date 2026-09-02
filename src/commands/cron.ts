import { pythonRepr } from "../serialization/python-repr.js";
import { CronStoreError, CronValidationError, CronStore } from "../cron/store.js";
import { formatJobValue } from "../cron/format.js";

export interface CronCommandOptions {
  readonly argv: readonly string[];
  readonly home: string;
}

type Result = Readonly<{ code: number; stdout: string; stderr: string }>;

const ACTIONS = ["list", "add", "remove", "pause", "resume"] as const;
type CronAction = (typeof ACTIONS)[number];

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function parsePythonInt(text: string): number | null {
  const trimmed = text.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parsePythonFloat(text: string): number | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "nan" || lower === "+nan" || lower === "-nan") return Number.NaN;
  if (lower === "inf" || lower === "+inf" || lower === "infinity" || lower === "+infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (lower === "-inf" || lower === "-infinity") return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/iu.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Manages scheduled jobs (list/add/remove/pause/resume). Ports cli.py's `run_cron` and its
 * argparse setup byte-exact for goldens (decision 12), with a dedicated, stable exit code (1) for
 * every store fail-closed error, distinguishable from the oracle's exit taxonomy (0/1/2) since
 * the fail-closed collapse (decision 3) has no oracle-side equivalent to reuse a code from.
 */
export function runCron(options: CronCommandOptions): Result {
  const { argv, home } = options;
  const rawAction = argv[1];
  if (rawAction === undefined) {
    return {
      code: 2,
      stdout: "",
      stderr: "lohra cron: error: the following arguments are required: action\n",
    };
  }
  if (!(ACTIONS as readonly string[]).includes(rawAction)) {
    return {
      code: 2,
      stdout: "",
      stderr:
        `lohra cron: error: argument action: invalid choice: ${pythonRepr(rawAction)} ` +
        `(choose from 'list', 'add', 'remove', 'pause', 'resume')\n`,
    };
  }
  const action = rawAction as CronAction;
  const positional = argv[2];
  const jobId = positional !== undefined && !positional.startsWith("--") ? positional : undefined;

  const intervalText = option(argv, "--interval");
  const cronExpr = option(argv, "--cron");
  const atText = option(argv, "--at");
  let interval: number | undefined;
  if (intervalText !== undefined) {
    const parsed = parsePythonInt(intervalText);
    if (parsed === null) {
      return {
        code: 2,
        stdout: "",
        stderr: `lohra cron: error: argument --interval: invalid int value: ${pythonRepr(intervalText)}\n`,
      };
    }
    interval = parsed;
  }
  let at: number | undefined;
  if (atText !== undefined) {
    const parsed = parsePythonFloat(atText);
    if (parsed === null) {
      return {
        code: 2,
        stdout: "",
        stderr: `lohra cron: error: argument --at: invalid float value: ${pythonRepr(atText)}\n`,
      };
    }
    at = parsed;
  }

  const store = new CronStore(home);

  try {
    if (action === "list") {
      const jobs = store.list();
      if (jobs.length === 0) return { code: 0, stdout: "no scheduled jobs\n", stderr: "" };
      const lines = jobs.map((job) => {
        const state = job.enabled ? "on" : "paused";
        return `${job.id}  [${state}] ${job.name}  (${job.type}=${formatJobValue(job.type, job.value)})`;
      });
      return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }

    if (action === "add") {
      let scheduleType: string;
      let value: unknown;
      if (interval !== undefined) {
        scheduleType = "interval";
        value = interval;
      } else if (cronExpr !== undefined) {
        scheduleType = "cron";
        value = cronExpr;
      } else if (at !== undefined) {
        scheduleType = "once";
        value = at;
      } else {
        return { code: 2, stdout: "", stderr: "add needs one of --interval, --cron, or --at\n" };
      }
      try {
        const job = store.add({
          name: option(argv, "--name") ?? "",
          prompt: option(argv, "--prompt") ?? "",
          type: scheduleType,
          value,
        });
        return { code: 0, stdout: `added job ${job.id}\n`, stderr: "" };
      } catch (error) {
        if (error instanceof CronValidationError) {
          return { code: 2, stdout: "", stderr: `error: ${error.message}\n` };
        }
        throw error;
      }
    }

    if (jobId === undefined) {
      return { code: 2, stdout: "", stderr: `${action} needs a job id\n` };
    }
    const found = action === "remove" ? store.remove(jobId) : store.setEnabled(jobId, action === "resume");
    if (!found) {
      return { code: 1, stdout: "", stderr: `no job with id ${pythonRepr(jobId)}\n` };
    }
    return { code: 0, stdout: `${action} ${jobId}\n`, stderr: "" };
  } catch (error) {
    if (error instanceof CronStoreError) {
      return { code: 1, stdout: "", stderr: `${error.message}\n` };
    }
    throw error;
  }
}
