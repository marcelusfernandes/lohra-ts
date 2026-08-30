export type SubSessionStatus = "running" | "complete" | "error" | "interrupted";

export interface CollectResult {
  readonly status: SubSessionStatus;
  readonly output: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly forcedFallback: boolean;
  readonly errorKind: string | null;
  readonly retryAfter: number | null;
}

export interface SpawnConfig {
  readonly prompt: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly maxIterations?: number;
}

/**
 * Runs one child turn to completion and resolves with its outcome — never
 * rejects. A child that fails, is interrupted, or hits a provider error
 * resolves with status "error"/"interrupted" and the relevant fields set;
 * rejection is reserved for programming errors in the runner itself, not
 * for anything the oracle's contract classifies as a child outcome.
 */
export type ChildRunner = (subId: string, config: SpawnConfig) => Promise<CollectResult>;

export interface OrchestrationCoreOptions {
  readonly runChild: ChildRunner;
  readonly idSource: () => string;
  readonly maxSubsessions: number;
}

export type CollectOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "pending" }
  | { readonly kind: "settled"; readonly result: CollectResult };

interface SubSessionEntry {
  readonly subId: string;
  status: SubSessionStatus;
  result: CollectResult | null;
  readonly promise: Promise<CollectResult>;
}

/**
 * The in-process registry backing spawn_session/collect_session. Spawn is
 * non-blocking by construction: it starts runChild and returns immediately,
 * proven by call order in tests, never by latency (contract L5).
 *
 * Eviction mirrors the oracle's _evict_if_needed (L9): it runs on spawn,
 * removes only a terminal entry (never running), and the registry cap is a
 * target, not a barrier — spawning over cap with no terminal entry to evict
 * leaves the registry above cap rather than blocking or erroring.
 */
export class OrchestrationCore {
  private readonly entries = new Map<string, SubSessionEntry>();
  private readonly insertionOrder: string[] = [];

  public constructor(private readonly options: OrchestrationCoreOptions) {}

  public get size(): number {
    return this.entries.size;
  }

  public spawn(config: SpawnConfig): { readonly subId: string } {
    this.evictOneTerminalIfOverCap();
    const subId = this.options.idSource();
    const promise = this.options.runChild(subId, config).then((result) => {
      const entry = this.entries.get(subId);
      if (entry !== undefined) {
        entry.status = result.status;
        entry.result = result;
      }
      return result;
    });
    this.entries.set(subId, { subId, status: "running", result: null, promise });
    this.insertionOrder.push(subId);
    return { subId };
  }

  public async collect(subId: string, wait: boolean): Promise<CollectOutcome> {
    const entry = this.entries.get(subId);
    if (entry === undefined) return { kind: "not-found" };
    if (entry.result !== null) return { kind: "settled", result: entry.result };
    if (!wait) return { kind: "pending" };
    const result = await entry.promise;
    return { kind: "settled", result };
  }

  private evictOneTerminalIfOverCap(): void {
    if (this.entries.size < this.options.maxSubsessions) return;
    for (const id of this.insertionOrder) {
      const entry = this.entries.get(id);
      if (entry !== undefined && entry.status !== "running") {
        this.entries.delete(id);
        this.insertionOrder.splice(this.insertionOrder.indexOf(id), 1);
        return;
      }
    }
  }
}
