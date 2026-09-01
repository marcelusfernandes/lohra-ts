
export const MIN_RESUME_DELAY = 60;
export const MAX_RESUME_DELAY = 6 * 60 * 60;
export const MAX_RESUME_ATTEMPTS = 5;
export const HEARTBEAT_TICKS_PER_TTL = 3;

export type Timer = { cancel(): void };

export type TimerFactory = (delay: number, fire: () => void) => Timer;

export function resumeDelay(attempts: number, retryAfter?: number | null): number {
  if (retryAfter !== undefined && retryAfter !== null && retryAfter > 0) {
    return Math.min(Math.max(retryAfter, MIN_RESUME_DELAY), MAX_RESUME_DELAY);
  }
  return Math.min(MIN_RESUME_DELAY * 2 ** Math.max(0, attempts), MAX_RESUME_DELAY);
}

function defaultTimer(delay: number, fire: () => void): Timer {
  const handle = setTimeout(fire, delay * 1000);
  const timer = handle as unknown as { unref?(): void };
  if (typeof timer.unref === "function") timer.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

/**
 * Keeps a live run's lease fresh on a TIMER, not on its output: a node that
 * outlives the TTL must not lapse the lease of the run still inside it.
 * Ticks TTL/3 — a tick may be lost and a live run still never lapses.
 */
export class LeaseHeartbeat {
  private readonly renew: (runId: string) => boolean;
  private readonly interval: number;
  private readonly timerFactory: (delay: number, fire: () => void) => Timer;
  private readonly logError: (...args: unknown[]) => void;
  private readonly active = new Set<string>();
  private readonly timers = new Map<string, Timer>();

  public constructor(
    renew: (runId: string) => boolean,
    options: {
      readonly interval: number;
      readonly timerFactory?: (delay: number, fire: () => void) => Timer;
      readonly logError?: (...args: unknown[]) => void;
    },
  ) {
    this.renew = renew;
    this.interval = Math.max(0.1, options.interval);
    this.timerFactory = options.timerFactory ?? defaultTimer;
    this.logError = options.logError ?? console.error;
  }

  public start(runId: string): void {
    this.active.add(runId);
    this.arm(runId);
  }

  public stop(runId: string): void {
    this.active.delete(runId);
    this.drop(runId);
  }

  public shutdown(): void {
    this.active.clear();
    for (const runId of [...this.timers.keys()]) this.drop(runId);
  }

  private arm(runId: string): void {
    const timer = this.timerFactory(this.interval, () => { this.tick(runId); });
    if (!this.active.has(runId)) {
      // a stop()/shutdown() won the race against this (re-)arm
      timer.cancel();
      return;
    }
    this.drop(runId);
    this.timers.set(runId, timer);
  }

  private drop(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer !== undefined) {
      this.timers.delete(runId);
      timer.cancel();
    }
  }

  private tick(runId: string): void {
    // Claim the tick: a stop that raced us already popped it, and renewing a
    // lease this process let go of would keep a finished run looking alive.
    if (!this.timers.delete(runId)) return;
    let held: boolean;
    try {
      held = this.renew(runId);
    } catch (error) {
      this.logError("workflow: lease heartbeat for run failed", runId, error);
      held = true; // one lost write is what the TTL is for — keep beating
    }
    if (!held) return; // the lease is somebody else's now; beating on is noise
    this.arm(runId);
  }
}

export type ResumeOutcome = Readonly<{ run_id: string; status: string; error?: string }>;

/** One pending retry per run_id; cancelling a run cancels its retry. */
export class AutoResumeScheduler {
  private readonly resume: (runId: string) => unknown;
  private readonly timerFactory: (delay: number, fire: () => void) => Timer;
  private readonly logWarning: (message: string) => void;
  private readonly maxAttempts: number;
  private readonly timers = new Map<string, Timer>();

  public constructor(
    resume: (runId: string) => unknown,
    options: {
      readonly timerFactory?: (delay: number, fire: () => void) => Timer;
      readonly maxAttempts?: number;
      readonly logWarning?: (message: string) => void;
    } = {},
  ) {
    this.resume = resume;
    this.timerFactory = options.timerFactory ?? defaultTimer;
    this.maxAttempts = Math.max(0, options.maxAttempts ?? MAX_RESUME_ATTEMPTS);
    this.logWarning = options.logWarning ?? ((message) => { console.warn(message); });
  }

  public schedule(runId: string, options: { attempts: number; retryAfter?: number | null }): number | null {
    if (options.attempts >= this.maxAttempts) {
      this.logWarning(
        `workflow: run ${runId} stays paused after ${String(options.attempts)} auto-resume attempt(s); resume it manually with run_workflow(resume_run_id=...)`,
      );
      return null;
    }
    const delay = resumeDelay(options.attempts, options.retryAfter);
    const timer = this.timerFactory(delay, () => { this.fire(runId); });
    this.drop(runId);
    this.timers.set(runId, timer);
    return delay;
  }

  public cancel(runId: string): void {
    this.drop(runId);
  }

  public shutdown(): void {
    for (const runId of [...this.timers.keys()]) this.drop(runId);
  }

  /**
   * Cold start: re-arm the quota-paused runs a dead process left behind, with
   * the attempts it had already spent carried from the durable line. Token-
   * budget pauses never re-arm (waiting does not refill a budget).
   */
  public rearmPendingResumes(
    pausedOn: (pauseReason: string) => readonly { readonly run_id: string }[],
    attemptsOf: (runId: string) => number,
  ): readonly string[] {
    const rearmed: string[] = [];
    for (const row of pausedOn("quota_exhausted")) {
      const runId = row.run_id;
      if (this.timers.has(runId)) continue;
      const delay = this.schedule(runId, { attempts: attemptsOf(runId) });
      if (delay !== null) rearmed.push(runId);
    }
    return rearmed;
  }

  private drop(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer !== undefined) {
      this.timers.delete(runId);
      timer.cancel();
    }
  }

  private fire(runId: string): void {
    if (!this.timers.delete(runId)) return; // a cancel raced and won
    let outcome: unknown;
    try {
      outcome = this.resume(runId);
    } catch (error) {
      this.logWarning(`workflow: auto-resume of run ${runId} failed: ${String(error)}`);
      return;
    }
    if (
      outcome !== null &&
      typeof outcome === "object" &&
      "error" in outcome &&
      typeof (outcome).error === "string"
    ) {
      this.logWarning(
        `workflow: auto-resume of run ${runId} refused: ${(outcome as { error: string }).error}`,
      );
    }
  }
}
