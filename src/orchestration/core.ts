import { ConcurrencyGate } from "./concurrency-gate.js";
import { logOrchestrationFailure } from "./failure-log.js";
import { wrapSteerInbox } from "./steer-inbox.js";

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
 *
 * drainMessages must be threaded straight into the real turn loop's own
 * per-iteration injection hook (ConversationRuntime's drainMessages option)
 * — it returns whatever steer_session has queued for this child, already
 * wrapped into the busy-form <system-reminder> message (contract decision 6
 * / L6), or an empty array when nothing is pending. The runner must not
 * drain steer input any other way.
 *
 * signal must be threaded straight into the real turn loop's own cancellation
 * hook (ConversationRuntime's signal option) — the same cooperative,
 * checked-between-iterations mechanism as the parent's own Ctrl-C, never a
 * mid-flight abort of an upstream call in progress (contract assertion 40).
 * shutdown() is this signal's only trigger today (contract L16).
 */
export type ChildRunner = (
  subId: string,
  config: SpawnConfig,
  systemPrompt: string,
  drainMessages: () => readonly Readonly<Record<string, unknown>>[],
  signal: AbortSignal,
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

export interface DelegateOutcome {
  readonly subId: string;
  readonly status: SubSessionStatus;
  readonly summary: string;
}

/** "(subagent produced no output)" for an empty-output success, textually
 * distinct from an error (contract L17) — shared by delegate()'s own batch
 * path and any caller building a single-result batch envelope from a
 * resume_id steer+collect (delegate_task's resume form), so the two never
 * drift into producing different text for the same underlying result. */
export function summarizeCollectResult(result: CollectResult | null): string {
  if (result === null) return "";
  if (result.status === "complete" && result.output === "") return "(subagent produced no output)";
  return result.output;
}

interface SubSessionEntry {
  readonly subId: string;
  readonly systemPrompt: string;
  /** The original spawn overrides (model/provider/effort/maxIterations),
   * reused verbatim on an idle/terminal steer resurrection — steer_session
   * carries no override arguments of its own. */
  readonly originalConfig: SpawnConfig;
  /** Publicly observable via collect(wait:false) — stays STALE during a
   * steer-driven resurrection until the new turn actually settles (contract
   * L7 / ADR-T13-05: reproduced deliberately, not fixed). */
  status: SubSessionStatus;
  result: CollectResult | null;
  /** True from the moment ANY turn (initial or steer-resurrected) starts
   * until it settles — independent of the possibly-stale status/result
   * above. This, not `result === null`, is what steer() must consult to
   * tell busy from idle: after a resurrection, `result` stays stale on
   * purpose (L7), so checking it for busyness would wrongly treat an
   * already-busy resurrected child as idle and start a second, redundant
   * turn instead of queuing into the inbox. */
  inFlight: boolean;
  /** The LATEST turn's promise. collect(wait:true) always awaits this one,
   * never the possibly-stale `result` above — reassigned on every steer
   * resurrection so a wait always tracks the turn actually in flight. */
  promise: Promise<CollectResult>;
  /** Backs the LATEST turn's cancellation signal — reassigned alongside
   * `promise` on every steer resurrection so shutdown() always aborts the
   * turn actually in flight, never a stale controller from an earlier one. */
  abortController: AbortController;
  /** Pending raw steer texts, merged into one <system-reminder> message and
   * drained by the runner's own iteration loop while this child is busy or
   * queued-in-pool (contract L6). */
  readonly inbox: string[];
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
    const { promise, abortController } = this.runAndTrack(subId, config, systemPrompt);
    this.entries.set(subId, {
      subId,
      systemPrompt,
      originalConfig: config,
      status: "running",
      result: null,
      inFlight: true,
      promise,
      abortController,
      inbox: [],
    });
    this.insertionOrder.push(subId);
    return { subId };
  }

  /**
   * Spawns one child per task and BLOCKS until every one settles — the
   * opposite of spawn's non-blocking contract (contract L5, the two verbs
   * are opposite by design). Order in the returned array always matches
   * task order, never completion order: Promise.all preserves index-based
   * ordering of its input array regardless of which promise settles first,
   * so no extra bookkeeping is needed to satisfy L17's shuffled-completion
   * requirement. A failing task never aborts the batch or throws — each
   * spawned child already resolves (never rejects) per ChildRunner's own
   * contract, so Promise.all can't short-circuit here.
   */
  public async delegate(
    tasks: readonly string[],
    overrides: Omit<SpawnConfig, "prompt"> = {},
  ): Promise<readonly DelegateOutcome[]> {
    const spawned = tasks.map((task) => this.spawn({ ...overrides, prompt: task }));
    return Promise.all(
      spawned.map(async ({ subId }): Promise<DelegateOutcome> => {
        const outcome = await this.collect(subId, true);
        const result = outcome.kind === "settled" ? outcome.result : null;
        return { subId, status: result?.status ?? "error", summary: summarizeCollectResult(result) };
      }),
    );
  }

  /**
   * Injects raw text into a running/queued child's inbox (busy or
   * queued-in-pool, contract L6) — returns queued:true; or resurrects an
   * idle/terminal child with the text as a new turn's raw input — returns
   * queued:false. Returns null for an unknown sub_id (caller maps this to
   * "no sub-session"). Busy is determined by `inFlight`, not by `result`:
   * a queued-in-pool child (never yet made an upstream call because the
   * concurrency gate hasn't admitted it) is inFlight too, correctly treated
   * as busy; a resurrected child mid-second-turn is ALSO inFlight even
   * though its `result` is still the stale first-turn value (L7) — steering
   * it again must queue, not start a redundant third turn.
   */
  public steer(subId: string, text: string): { readonly queued: boolean } | null {
    const entry = this.entries.get(subId);
    if (entry === undefined) return null;
    if (entry.inFlight) {
      entry.inbox.push(text);
      return { queued: true };
    }
    // Idle/terminal: resurrect. status/result are left untouched here on
    // purpose — L7/ADR-T13-05 requires collect(wait:false) to keep
    // returning the stale prior result until the new turn actually settles.
    entry.inFlight = true;
    const { promise, abortController } = this.runAndTrack(
      subId,
      { ...entry.originalConfig, prompt: text },
      entry.systemPrompt,
    );
    entry.promise = promise;
    entry.abortController = abortController;
    return { queued: false };
  }

  /** Drains this child's pending steer texts, merged into one
   * <system-reminder> message (contract L6) — empty when nothing is
   * pending. Intended to be threaded straight into the runner's own
   * drainMessages hook; also callable directly for inspection/testing. */
  public drainInboxFor(subId: string): readonly Readonly<Record<string, unknown>>[] {
    const entry = this.entries.get(subId);
    if (entry === undefined) return [];
    const pending = entry.inbox.splice(0, entry.inbox.length);
    return wrapSteerInbox(pending);
  }

  public async collect(subId: string, wait: boolean): Promise<CollectOutcome> {
    const entry = this.entries.get(subId);
    if (entry === undefined) return { kind: "not-found" };
    if (!wait) {
      // result === null means no turn has EVER settled yet — genuinely
      // pending, not merely stale. Once any turn has settled, a poll
      // returns that result even while a later resurrection is inFlight —
      // stale on purpose (L7), never "pending" again.
      if (entry.result === null) return { kind: "pending" };
      return { kind: "settled", result: entry.result };
    }
    const result = await entry.promise;
    return { kind: "settled", result };
  }

  /**
   * Cooperatively interrupts every tracked child (the same AbortSignal
   * machinery as the parent's own Ctrl-C, checked between iterations —
   * never a mid-flight abort of an upstream call already in progress, per
   * contract assertion 40) and blocks until every one actually settles: a
   * child stuck in an in-flight call finishes normally before this
   * resolves (drains, never abandons), and a child that would need another
   * iteration terminates "interrupted" instead of starting one. Mirrors the
   * oracle's `shutdown(wait=True)` — `shutdown(wait=False)` has no public
   * surface in this commit (T15, contract's own dívidas table).
   *
   * Any child that settles "error" or "interrupted" during the drain has
   * its cause logged via logOrchestrationFailure(home, ...) — the one
   * channel backing both assertion 41 (teardown interrupt cause) and
   * decision 14/ADR-T13-04 (uncollected child failure): shutdown does not
   * swallow failures, it just keeps them off the compared stdout/stderr
   * surface. `home` is passed in explicitly, never resolved here.
   */
  public async shutdown(home: string): Promise<void> {
    const children = [...this.entries.values()];
    for (const entry of children) entry.abortController.abort();
    await Promise.all(
      children.map(async (entry) => {
        const result = await entry.promise;
        if (result.status === "error" || result.status === "interrupted") {
          logOrchestrationFailure(home, {
            subId: entry.subId,
            status: result.status,
            output: result.output,
            errorKind: result.errorKind,
          });
        }
      }),
    );
  }

  /** Runs one child turn through the concurrency gate and updates the
   * entry's publicly-observable status/result once it settles. Shared by
   * spawn() (the initial turn) and steer()'s idle/terminal resurrection
   * (a later turn on the same sub_id) — the only difference is which
   * config (fresh prompt vs. the original overrides plus the steer text)
   * is passed through. Looks the entry up by subId inside the settlement
   * callback (rather than closing over it directly) so it works both before
   * spawn() has inserted the entry yet and after steer() replaces it.
   * Creates a fresh AbortController per turn — shutdown() is its only
   * trigger today — and hands the caller both so it can store the
   * controller on the entry alongside the promise it backs. */
  private runAndTrack(
    subId: string,
    config: SpawnConfig,
    systemPrompt: string,
  ): { readonly promise: Promise<CollectResult>; readonly abortController: AbortController } {
    const abortController = new AbortController();
    const drainMessages = (): readonly Readonly<Record<string, unknown>>[] =>
      this.drainInboxFor(subId);
    const promise = this.gate
      .run(() => this.options.runChild(subId, config, systemPrompt, drainMessages, abortController.signal))
      .then((result) => {
        const entry = this.entries.get(subId);
        if (entry === undefined) return result;
        // Usage accumulates across every turn of the child's whole lifetime
        // (measured against the oracle's own _finalize, sub.tokens_in += ...,
        // never overwritten) — a resurrected child's collect reports the SUM
        // of every turn's usage, not just the latest one. Every other field
        // (status/output/provider/model/forcedFallback/errorKind/retryAfter)
        // reflects the LATEST turn only, same as before.
        const previous = entry.result;
        const accumulated: CollectResult =
          previous === null
            ? result
            : {
                ...result,
                tokensIn: previous.tokensIn + result.tokensIn,
                tokensOut: previous.tokensOut + result.tokensOut,
                cacheReadTokens: previous.cacheReadTokens + result.cacheReadTokens,
                cacheWriteTokens: previous.cacheWriteTokens + result.cacheWriteTokens,
                reasoningTokens: previous.reasoningTokens + result.reasoningTokens,
              };
        entry.status = accumulated.status;
        entry.result = accumulated;
        entry.inFlight = false;
        return accumulated;
      });
    return { promise, abortController };
  }

  /** "Running" for eviction purposes means inFlight, not the possibly-stale
   * status field — a resurrected child whose status still reads "complete"
   * (L7) must not be evicted while its new turn is actually in flight. */
  private evictOneTerminalIfOverCap(): void {
    if (this.entries.size < this.options.maxSubsessions) return;
    for (const id of this.insertionOrder) {
      const entry = this.entries.get(id);
      if (entry !== undefined && !entry.inFlight) {
        this.entries.delete(id);
        this.insertionOrder.splice(this.insertionOrder.indexOf(id), 1);
        return;
      }
    }
  }
}
