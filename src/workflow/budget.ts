export const DEFAULT_POOL_WIDTH = 4;
export const DEFAULT_MAX_FANOUT = 64;
export const DEFAULT_LIFETIME = 1000;
export const ESTIMATED_TOKENS_PER_LEAF = 2000;

export class FanoutRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanoutRejected";
  }
}
export class TokenBudgetExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBudgetExhausted";
  }
}

export class Budget {
  readonly poolWidth: number;
  readonly maxFanout: number;
  readonly tokenBudget: number | null;
  private readonly lifetime: number;
  private spawned = 0;
  private input = 0;
  private output = 0;
  private measuredLeaves = 0;

  constructor(options: {
    readonly poolWidth?: number;
    readonly maxFanout?: number;
    readonly lifetime?: number;
    readonly tokenBudget?: number | null;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  } = {}) {
    this.poolWidth = Math.max(1, Math.trunc(options.poolWidth ?? DEFAULT_POOL_WIDTH));
    this.maxFanout = Math.max(1, Math.trunc(options.maxFanout ?? DEFAULT_MAX_FANOUT));
    this.lifetime = Math.max(1, Math.trunc(options.lifetime ?? DEFAULT_LIFETIME));
    this.tokenBudget = options.tokenBudget ?? null;
    this.input = Math.max(0, Math.trunc(options.tokensIn ?? 0));
    this.output = Math.max(0, Math.trunc(options.tokensOut ?? 0));
  }

  get lifetimeRemaining(): number {
    return Math.max(0, this.lifetime - this.spawned);
  }

  checkFanout(width: number): void {
    if (width > this.maxFanout)
      throw new FanoutRejected(`fan-out of ${String(width)} exceeds max_fanout ${String(this.maxFanout)}`);
    if (width > this.lifetimeRemaining)
      throw new FanoutRejected(
        `fan-out of ${String(width)} exceeds lifetime remaining ${String(this.lifetimeRemaining)}`,
      );
  }

  charge(count = 1): void {
    this.spawned += Math.max(0, Math.trunc(count));
  }

  chargeTokens(inputTokens: number, outputTokens: number): void {
    const input = Math.max(0, Math.trunc(inputTokens));
    const output = Math.max(0, Math.trunc(outputTokens));
    this.input += input;
    this.output += output;
    if (input > 0 || output > 0) this.measuredLeaves += 1;
  }

  get tokensIn(): number {
    return this.input;
  }

  get tokensOut(): number {
    return this.output;
  }

  get tokensSpent(): number {
    return this.input + this.output;
  }

  get tokensRemaining(): number {
    return this.tokenBudget === null ? 0 : Math.max(0, this.tokenBudget - this.tokensSpent);
  }

  get tokensExhausted(): boolean {
    return this.tokenBudget !== null && this.tokensSpent >= this.tokenBudget;
  }

  get estimatedLeafCost(): number {
    if (this.measuredLeaves === 0) return ESTIMATED_TOKENS_PER_LEAF;
    return Math.max(1, Math.trunc(this.tokensSpent / this.measuredLeaves));
  }

  affordableLeaves(): number | null {
    return this.tokenBudget === null
      ? null
      : Math.trunc(this.tokensRemaining / this.estimatedLeafCost);
  }

  snapshot(): Readonly<{ total: number; spent: number; remaining: number }> | null {
    if (this.tokenBudget === null) return null;
    return Object.freeze({
      total: this.tokenBudget,
      spent: this.tokensSpent,
      remaining: this.tokensRemaining,
    });
  }
}
