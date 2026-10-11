import { CronStoreError, type CronJob, type CronStore } from "./store.js";
import { isDue, isPermanentlyUnreachable } from "./schedule.js";

const SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EIO",
  "ENOENT",
  "EPERM",
  "ETIMEDOUT",
  "SQLITE_BUSY",
  "SQLITE_IOERR",
]);

const STORE_CAUSES: ReadonlyMap<string, string> = new Map([
  ["path is a directory, not a file", "cron_store_directory"],
  ["path is not readable", "cron_store_unreadable"],
  ["read failed", "cron_store_read_failed"],
  ["content is not valid JSON", "cron_store_invalid_json"],
  ["root is not an object", "cron_store_invalid_root"],
  ["'jobs' field is not a list", "cron_store_invalid_jobs"],
  ["a job entry is malformed", "cron_store_malformed_job"],
]);

/** Error messages and paths can contain prompts or credentials; emit only known causal fields. */
function safeCause(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof CronStoreError) {
      return STORE_CAUSES.get(current.safeCause) ?? "CronStoreError";
    }
    if (current === null || typeof current !== "object") break;
    if ("code" in current) {
      const code = current.code;
      if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) return code;
    }
    if (!("cause" in current)) break;
    current = current.cause;
  }
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  return error instanceof Error ? "Error" : "unknown";
}

function safeJobId(jobId: string): string {
  return /^[a-f0-9]{32}$/u.test(jobId) ? jobId : "unknown";
}

function report(diagnostics: ((message: string) => void) | undefined, message: string): void {
  (diagnostics ?? console.warn)(message);
}

export interface TickResult {
  readonly jobId: string;
  readonly ok: boolean;
}

/**
 * One scheduler pass. A list is only a candidate snapshot; each due candidate must win a fresh
 * store claim before dispatch. The claim persists before the callback, so a failed callback
 * consumes that occurrence and cannot trigger a retry storm. An invalid store still throws from
 * `list()` before any candidate is considered.
 */
export async function tick(
  store: CronStore,
  runJob: (job: CronJob) => Promise<void>,
  options: { readonly now: number; readonly diagnostics?: (message: string) => void },
): Promise<readonly TickResult[]> {
  const results: TickResult[] = [];
  for (const job of store.list()) {
    if (!isDue(job, { now: options.now })) {
      // Assertion 28: the NaN/Infinity `once` job is permanently unreachable, not merely
      // not-due-yet. Its diagnostic uses the supplied sink or the default warning sink.
      if (isPermanentlyUnreachable(job)) {
        report(
          options.diagnostics,
          `cron job ${safeJobId(job.id)} phase=schedule cause=unreachable`,
        );
      }
      continue;
    }
    let claimed: CronJob | null;
    try {
      claimed = store.tryClaimDue(job.id, options.now);
    } catch (error) {
      report(
        options.diagnostics,
        `cron job ${safeJobId(job.id)} phase=claim cause=${safeCause(error)}`,
      );
      throw error;
    }
    if (claimed === null) continue;
    let ok = true;
    try {
      await runJob(claimed);
    } catch (error) {
      ok = false;
      report(
        options.diagnostics,
        `cron job ${safeJobId(job.id)} phase=callback cause=${safeCause(error)}`,
      );
    }
    results.push({ jobId: job.id, ok });
  }
  return results;
}

export interface StopSignal {
  isSet(): boolean;
}

export interface SchedulerLoopOptions {
  readonly store: CronStore;
  readonly runJob: (job: CronJob) => Promise<void>;
  readonly stop: StopSignal;
  readonly tickIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly diagnostics?: (message: string) => void;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ports `run_scheduler_loop`. Refuses to start on an invalid store (assertion 23 — the one
 * `store.list()` call below runs OUTSIDE the loop's try/catch, so a CronStoreError propagates
 * out of this function immediately, before any job is ever considered.
 *
 * Ticks BEFORE the first wait, matching the oracle: an already-due job fires within seconds of
 * scheduler start, not up to a full tick-interval later.
 */
export async function runSchedulerLoop(options: SchedulerLoopOptions): Promise<void> {
  const now = options.now ?? (() => Date.now() / 1000);
  const wait = options.wait ?? defaultWait;
  const intervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;

  options.store.list();

  while (!options.stop.isSet()) {
    const diagnosticsState = { failed: false };
    const diagnostics = (message: string): void => {
      try {
        report(options.diagnostics, message);
      } catch (error) {
        diagnosticsState.failed = true;
        throw error;
      }
    };
    try {
      await tick(options.store, options.runJob, {
        now: now(),
        diagnostics,
      });
    } catch (error) {
      if (diagnosticsState.failed) throw error;
      diagnostics(`cron scheduler phase=tick cause=${safeCause(error)}`);
    }
    await wait(intervalMs);
  }
}
