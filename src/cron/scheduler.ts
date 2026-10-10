import type { CronJob, CronStore } from "./store.js";
import { isDue, isPermanentlyUnreachable } from "./schedule.js";

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
      // not-due-yet — a diagnostic goes to an internal sink (never stdout/stderr) so a probe can
      // confirm the mechanism fired, distinct from "the candidate stayed silent everywhere".
      if (isPermanentlyUnreachable(job)) {
        options.diagnostics?.(
          `cron job ${job.id} is permanently unreachable (value=${String(job.value)})`,
        );
      }
      continue;
    }
    const claimed = store.tryClaimDue(job.id, options.now);
    if (claimed === null) continue;
    let ok = true;
    try {
      await runJob(claimed);
    } catch {
      ok = false;
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
 * out of this function immediately, before any job is ever considered) — a stronger guarantee
 * than the oracle's own silent-degrade-to-empty-list startup.
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
    try {
      await tick(options.store, options.runJob, {
        now: now(),
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      });
    } catch {
      // Matches the oracle's log.warning-and-continue: a tick-level failure never kills the loop.
    }
    await wait(intervalMs);
  }
}
