import type { ChildToolDispatch, OrchestrationCore } from "../orchestration/core.js";
import { toolError } from "./sandbox.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "./runtime.js";

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
 */
function adaptSandboxWrap(
  wrap: (base: LeafToolDispatch) => LeafToolDispatch,
): (base: ChildToolDispatch) => ChildToolDispatch {
  return (base) => {
    const syncBase: LeafToolDispatch = (name, args) => pendingToken(base(name, args));
    const wrapped = wrap(syncBase);
    return async (name, args) => {
      const out = wrapped(name, args);
      const pending = readPending(out);
      return pending === undefined ? out : await pending;
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

  public constructor(private readonly core: OrchestrationCore) {}

  public installLeafSandbox(installation: LeafSandboxInstallation): LeafSandboxHandle {
    this.installations.set(installation.runId, installation);
    return {
      dispose: () => {
        const current = this.installations.get(installation.runId);
        if (current !== undefined && current.fence === installation.fence) {
          this.installations.delete(installation.runId);
        }
      },
    };
  }

  private wrapDispatchFor(runId: string): (base: ChildToolDispatch) => ChildToolDispatch {
    const installation = this.installations.get(runId);
    return installation === undefined ? () => denyAllDispatch : adaptSandboxWrap(installation.wrap);
  }

  public spawn(request: ChildSpawnRequest): string {
    return this.core.spawn({
      prompt: request.prompt,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
      wrapDispatch: this.wrapDispatchFor(request.causalContext.runId),
    }).subId;
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
      forcedFallback: result.forcedFallback,
      retryAfter: result.retryAfter,
      errorKind: result.errorKind,
    };
  }

  public steer(id: string, prompt: string): void {
    this.core.steer(id, prompt);
  }

  public cancel(id: string): void {
    this.core.cancel(id);
  }
}
