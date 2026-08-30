/**
 * A simple counting semaphore bounding how many tasks run at once. Backs
 * the fan-out limit behind --max-parallel/LOHRA_MAX_PARALLEL (contract
 * decision 8, assertions 24-27): spawning beyond the limit doesn't fail or
 * drop work, it queues — the same "queued, not rejected" semantics the
 * oracle's own pool exhibits, which is also why a spawned-but-not-yet-
 * started child still counts as "running" for steer/collect purposes (L6's
 * queued-in-pool case).
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  public constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`ConcurrencyGate limit must be a positive integer, got ${String(limit)}`);
    }
  }

  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}
