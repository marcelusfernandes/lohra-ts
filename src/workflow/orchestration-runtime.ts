import type { OrchestrationCore } from "../orchestration/core.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
  LeafSandboxInstallation,
} from "./runtime.js";

/** Uses the same child pool as public orchestration tools for workflow leaves. */
export class OrchestrationChildRuntime implements ChildRuntime {
  public constructor(private readonly core: OrchestrationCore) {}

  // TODO(#107, red): install/dispose bookkeeping and the sync/async shim
  // land in the next commit.
  public installLeafSandbox(_installation: LeafSandboxInstallation): LeafSandboxHandle {
    throw new Error("not implemented");
  }

  public spawn(request: ChildSpawnRequest): string {
    return this.core.spawn({
      prompt: request.prompt,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
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
