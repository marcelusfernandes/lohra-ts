import type { CronJob, CronStore } from "./store.js";
import { isDue } from "./schedule.js";

export interface TickResult {
  readonly jobId: string;
  readonly ok: boolean;
}

/**
 * One scheduler pass. Ports scheduler.py's `tick()` with a deliberate, ADR-driven difference:
 * the oracle's `job.get("id")` sits OUTSIDE the per-job try block, so a non-dict entry aborts the
 * WHOLE tick (contradicting its own docstring) — this is R7/assertion 36, `[oracle-only]` by
 * construction, since `store.list()` already throws CronStoreError before a malformed entry could
 * ever reach this loop. The candidate never has that state to reproduce.
 *
 * A failed `runJob` still marks `last_run_at` — deliberate in the oracle (avoids a retry storm at
 * the cost of skipping the window) and reproduced here, not "fixed".
 */
export async function tick(
  store: CronStore,
  runJob: (job: CronJob) => Promise<void>,
  options: { readonly now: number },
): Promise<readonly TickResult[]> {
  const results: TickResult[] = [];
  for (const job of store.list()) {
    if (!isDue(job, { now: options.now })) continue;
    let ok = true;
    try {
      await runJob(job);
    } catch {
      ok = false;
    }
    store.markRun(job.id, options.now);
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
      await tick(options.store, options.runJob, { now: now() });
    } catch {
      // Matches the oracle's log.warning-and-continue: a tick-level failure never kills the loop.
    }
    await wait(intervalMs);
  }
}
