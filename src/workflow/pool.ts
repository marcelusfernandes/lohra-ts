export type ReleaseSlot = () => void;

/** A run-scoped async semaphore shared with nested engines. */
export class BoundedPool {
  private readonly width: number;
  private active = 0;
  private readonly waiting: ((release: ReleaseSlot) => void)[] = [];

  constructor(width: number) {
    this.width = Math.max(1, Math.trunc(width));
  }

  acquire(): Promise<ReleaseSlot> {
    if (this.active < this.width) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private releaseOnce(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next !== undefined) {
        next(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}
