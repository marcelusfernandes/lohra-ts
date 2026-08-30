import { ConcurrencyGate } from "./concurrency-gate.js";

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
 *
 * systemPrompt is the FROZEN subagent prompt text for this sub_id (contract
 * decision 25) — captured once by the registry at spawn and handed to every
 * subsequent call for the same sub_id verbatim. The runner must never build
 * its own prompt text; it only ever receives what the registry already froze.
 */
export type ChildRunner = (
  subId: string,
  config: SpawnConfig,
  systemPrompt: string,
) => Promise<CollectResult>;

export interface OrchestrationCoreOptions {
  readonly runChild: ChildRunner;
  readonly idSource: () => string;
  readonly maxSubsessions: number;
  /** Bounds how many children actually run runChild at once (contract
   * decision 8 / assertions 24-27, --max-parallel/LOHRA_MAX_PARALLEL). A
   * child spawned beyond this limit is registered and collectable
   * immediately — spawn stays non-blocking — but its runChild call doesn't
   * start until a slot frees, matching the oracle's queued-in-pool
   * semantics (L6). */
  readonly maxParallel: number;
  /** Builds the subagent system prompt text. Called exactly once per spawned
   * child — the registry freezes the result on the SubSession entry and
   * never calls this again for that sub_id, including across steer-driven
   * later turns (contract decision 25 / assertion 51). */
  readonly buildSubagentPrompt: () => string;
}

export type CollectOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "pending" }
  | { readonly kind: "settled"; readonly result: CollectResult };

interface SubSessionEntry {
  readonly subId: string;
  readonly systemPrompt: string;
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
  private readonly gate: ConcurrencyGate;

  public constructor(private readonly options: OrchestrationCoreOptions) {
    this.gate = new ConcurrencyGate(options.maxParallel);
  }

  public get size(): number {
    return this.entries.size;
  }

  /** The frozen subagent prompt captured at spawn for this sub_id (contract
   * decision 25) — undefined for an unknown sub_id. */
  public getSubagentPrompt(subId: string): string | undefined {
    return this.entries.get(subId)?.systemPrompt;
  }

  public spawn(config: SpawnConfig): { readonly subId: string } {
    this.evictOneTerminalIfOverCap();
    const subId = this.options.idSource();
    const systemPrompt = this.options.buildSubagentPrompt();
    const promise = this.gate
      .run(() => this.options.runChild(subId, config, systemPrompt))
      .then((result) => {
        const entry = this.entries.get(subId);
        if (entry !== undefined) {
          entry.status = result.status;
          entry.result = result;
        }
        return result;
      });
    this.entries.set(subId, { subId, systemPrompt, status: "running", result: null, promise });
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
