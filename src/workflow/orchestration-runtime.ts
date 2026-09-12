import type { ChildToolDispatch, OrchestrationCore } from "../orchestration/core.js";
import { toolError } from "./sandbox.js";
import type {
  CausalContext,
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafIdentity,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "./runtime.js";

/** A frozen, independent copy of `causal` — never the caller's own object
 * reference, and never mutable after this returns (issue #422: `causalSnapshot`
 * must hand back a snapshot, not a handle the caller could go on mutating). */
function freezeCausalContext(causal: CausalContext): CausalContext {
  return Object.freeze({ ...causal, nodePath: Object.freeze([...causal.nodePath]) });
}

/**
 * Carries the real, async dispatch call a sandbox `wrap` (runtime.ts:52-61)
 * kicked off — see `adaptSandboxWrap` below. Never produced by anything
 * OTHER than that shim, so `readPending` never mistakes a real tool result
 * (always a plain string) for one of these.
 */
class PendingDispatch {
  public constructor(public readonly promise: Promise<string>) {}
}

function pendingToken(promise: Promise<string>): string {
  // The sandbox's own contract (LeafToolDispatch, runtime.ts:44) is
  // synchronous and returns `string`; this object never actually reaches
  // a caller as a string — see adaptSandboxWrap, which only ever compares
  // it by `instanceof` before it could be used as text.
  return new PendingDispatch(promise) as unknown as string;
}

function readPending(value: string): Promise<string> | undefined {
  const candidate = value as unknown;
  return candidate instanceof PendingDispatch ? candidate.promise : undefined;
}

/** Parses `onToolSettled`'s `ok` from the tool envelope's own leading
 * `{"ok":...` (never the rest of the payload) — real envelopes come from
 * `toolResult`/`toolError`, src/tools/envelope.ts. */
function okFromEnvelope(result: string): boolean {
  return result.startsWith('{"ok":true');
}

/**
 * Bridges the sandbox's synchronous `LeafToolDispatch` contract
 * (runtime.ts:44, `LeafSandboxInstallation.wrap`) to the child pool's real,
 * asynchronous dispatch (`ChildToolDispatch`, core.ts). Calls `wrap` exactly
 * ONCE — the same call frequency service.ts's own composition uses
 * (stretchToolDispatch/sandboxDispatch/taintWrap are all called once per
 * acquisition, then reused per call) — producing one persistent per-leaf
 * dispatcher.
 *
 * The `base` handed to `wrap` is synchronous only in SHAPE: instead of
 * returning the tool's real output, it starts the real async dispatch and
 * hands back an opaque `PendingDispatch` token (never a plain string, so it
 * can never collide with a real result). The async dispatcher this function
 * returns recognizes that token and awaits the real promise; anything else
 * `wrap` returns is a synchronous DENIAL that never called `base` at all —
 * per contract, a denial never reaches (and never needs to unwrap) a token.
 *
 * Issue #367: `subId` — unknown to `wrapDispatchFor` at RESOLVE time, since
 * `core.spawn` mints it — arrives here as a second argument instead, read by
 * `createChildRunner` once it is in scope and threaded straight through to
 * `installation.wrap`. After the real dispatch settles (never for a sync
 * denial — that path returns before `pending` exists), `onToolSettled` fires
 * with `ok` parsed from the tool envelope's own leading `{"ok":...` (never
 * the rest of the payload) — see `okFromEnvelope` above.
 *
 * `onRefusal` (#246) is THIS leaf's own counting side channel: every
 * synchronous denial (never a `PendingDispatch`) fires it, keyed by `subId`.
 * A real tool call — even one that later reports its OWN failure — always
 * produced a token first, so it is never counted here; only a call the wrap
 * itself turned away before `base` ran is a sandbox refusal.
 */
function adaptSandboxWrap(
  installation: LeafSandboxInstallation,
  onRefusal: (subId: string) => void,
): (base: ChildToolDispatch, subId: string) => ChildToolDispatch {
  return (base, subId) => {
    const leaf: LeafIdentity = Object.freeze({ subId });
    const syncBase: LeafToolDispatch = (name, args) => pendingToken(base(name, args));
    const wrapped = installation.wrap(syncBase, leaf);
    return async (name, args) => {
      const out = wrapped(name, args);
      const pending = readPending(out);
      if (pending === undefined) {
        onRefusal(subId);
        return out;
      }
      const result = await pending;
      installation.onToolSettled?.(leaf, okFromEnvelope(result));
      return result;
    };
  };
}

/**
 * What a leaf gets when its run's acquisition has no live sandbox
 * installation — never runs a leaf's tool unsandboxed (CLAUDE.md invariant
 * 4). Reached only when `spawn` is called for a `causalContext.runId` that
 * was never installed, or whose installation has since been disposed —
 * both are programming errors in the caller (WorkflowService always installs
 * before a leaf can spawn, runtime.ts:75-84), so this is defense in depth,
 * not an expected path.
 */
const denyAllDispatch: ChildToolDispatch = (name) =>
  Promise.resolve(
    toolError(`no leaf sandbox installed for this run — '${name}' denied fail-closed`),
  );

/**
 * Uses the same child pool as public orchestration tools for workflow
 * leaves, and additionally implements the leaf sandbox seam
 * (`ChildRuntime.installLeafSandbox`, runtime.ts:75-84) that
 * `WorkflowService.launchDurable` requires before any durable run's leaf can
 * spawn (service.ts:820-848).
 *
 * One installation lives per `runId` at a time, keyed by the acquisition's
 * `fence` — `dispose()` only clears the map entry when the fence it holds is
 * still the current one, so an OLDER acquisition's disposal (issued after a
 * newer one already took over) never removes the newer installation
 * (runtime.ts:64-66, "removes ONLY the installation it came from").
 *
 * `spawn` resolves the wrap for `request.causalContext.runId` ONCE, at spawn
 * time, and hands it to `OrchestrationCore` as `SpawnConfig.wrapDispatch` —
 * `core.ts`'s `steer()` resurrection reuses `entry.originalConfig` verbatim,
 * so a later steer-driven turn keeps the exact same wrap without this class
 * doing anything extra. A runId with no live installation gets
 * `denyAllDispatch`: the leaf still runs (spawn never blocks or throws), but
 * every one of its tool calls is denied before reaching the real dispatch —
 * fail-closed, never fail-open.
 */
export class OrchestrationChildRuntime implements ChildRuntime {
  private readonly installations = new Map<string, LeafSandboxInstallation>();
  /** Per-leaf refusal counters (#246), keyed by the leaf's own subId so
   * `collect` can read them back. `runId` rides along so `installLeafSandbox`'s
   * `dispose()` can sweep only the entries its OWN acquisition created —
   * bounded by one stretch's leaves, same lifetime as `installations`. */
  private readonly refusalCounts = new Map<
    string,
    { readonly runId: string; readonly box: { count: number } }
  >();
  /** Live leaves' causal identity (issue #422), keyed by subId — read back
   * by `causalSnapshot` so a supervision tool can resolve `node_id ->
   * sub_id` (S3). Populated EAGERLY at spawn (every leaf gets an entry, not
   * just ones that ever get steered/refused) and swept by the SAME `dispose`
   * that clears `refusalCounts` above, so its lifetime matches: bounded by
   * one stretch's leaves under a durable install, but — like
   * `refusalCounts` — never swept at all for a run that never had a leaf
   * sandbox installed (the ephemeral, no-store path, #101). That leaf pool
   * is itself bounded by `OrchestrationCore`'s own `maxSubsessions`
   * eviction, so this never grows past what the registry already allows. */
  private readonly causalContexts = new Map<string, CausalContext>();

  public constructor(private readonly core: OrchestrationCore) {}

  public installLeafSandbox(installation: LeafSandboxInstallation): LeafSandboxHandle {
    this.installations.set(installation.runId, installation);
    return {
      dispose: () => {
        const current = this.installations.get(installation.runId);
        if (current !== undefined && current.fence === installation.fence) {
          this.installations.delete(installation.runId);
          for (const [subId, entry] of this.refusalCounts) {
            if (entry.runId === installation.runId) this.refusalCounts.delete(subId);
          }
          for (const [subId, causal] of this.causalContexts) {
            if (causal.runId === installation.runId) this.causalContexts.delete(subId);
          }
        }
      },
    };
  }

  private wrapDispatchFor(
    runId: string,
  ): (base: ChildToolDispatch, subId: string) => ChildToolDispatch {
    const installation = this.installations.get(runId);
    return installation === undefined
      ? () => denyAllDispatch
      : adaptSandboxWrap(installation, (subId) => {
          this.recordRefusal(runId, subId);
        });
  }

  /** Lazily creates this leaf's counter on its FIRST refusal — `subId` is
   * only known once `core.spawn` mints it and hands it to the dispatcher
   * (issue #367), so there is no earlier point to pre-create the box. A
   * leaf with zero refusals never gets an entry; `collect` below defaults
   * an absent entry to 0, so that is indistinguishable from "not counted
   * yet" and both read 0. */
  private recordRefusal(runId: string, subId: string): void {
    let entry = this.refusalCounts.get(subId);
    if (entry === undefined) {
      entry = { runId, box: { count: 0 } };
      this.refusalCounts.set(subId, entry);
    }
    entry.box.count += 1;
  }

  public spawn(request: ChildSpawnRequest): string {
    const subId = this.core.spawn({
      prompt: request.prompt,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
      wrapDispatch: this.wrapDispatchFor(request.causalContext.runId),
    }).subId;
    this.causalContexts.set(subId, freezeCausalContext(request.causalContext));
    return subId;
  }

  /** A frozen copy of the leaf's causal identity, or null once it is
   * unknown (never spawned here, or already swept by `dispose`) — issue
   * #422. Never the object `spawn` was originally called with (see
   * `freezeCausalContext`). */
  public causalSnapshot(id: string): CausalContext | null {
    return this.causalContexts.get(id) ?? null;
  }

  public async collect(id: string, options: ChildCollectOptions): Promise<ChildResult> {
    const outcome = await this.core.collect(id, options.wait);
    if (outcome.kind === "not-found") {
      return { status: "failed", output: "no such workflow child" };
    }
    if (outcome.kind === "pending") return { status: "running", output: null };
    const result = outcome.result;
    const status =
      result.status === "complete"
        ? "complete"
        : result.status === "interrupted"
          ? "cancelled"
          : "failed";
    return {
      status,
      output: result.output,
      usage: {
        inputTokens: result.tokensIn,
        outputTokens: result.tokensOut,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        reasoningTokens: result.reasoningTokens,
      },
      provider: result.provider,
      model: result.model,
      retryAfter: result.retryAfter,
      errorKind: result.errorKind,
      usageUncertain: result.usageUncertain === true,
      sandboxRefusals: this.refusalCounts.get(id)?.box.count ?? 0,
    };
  }

  /**
   * Forwards `causal` straight to `core.steer` (issue #422 — previously
   * dropped here). `core.steer`'s own per-leaf cap
   * (`MAX_PENDING_STEERS_PER_LEAF`, core.ts) can refuse the call
   * (`refused: "steer_cap"`); this port's `steer` returns `void`
   * (`ChildRuntime.steer`, runtime.ts) and discards that return value —
   * the refusal is already visible one layer up, as a named `toolError`,
   * for the one caller that goes through `OrchestrationCore.steer`
   * directly (`orchestration/tools.ts`'s `steerSessionTool`/
   * `delegate_task`'s resume). It is NOT yet observable through THIS
   * method — `workflow_steer` (issue #424, M10-S3) calls it through this
   * port and cannot distinguish queued/resurrected/refused; a future issue
   * widens this signature to return `core.steer`'s own outcome instead of
   * `void` (comment in #424, 2026-09-12).
   */
  public steer(id: string, prompt: string, causal?: CausalContext): void {
    this.core.steer(id, prompt, causal);
  }

  public cancel(id: string): void {
    this.core.cancel(id);
  }
}
