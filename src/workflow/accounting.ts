import { combineUsage, usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";

export type RunStatus = "complete" | "degraded" | "failed" | "cancelled" | "paused";

export class NodeCost {
  readonly usage: Usage;
  readonly provider: string | null;
  readonly model: string | null;

  constructor(init: { usage?: Usage; provider?: string | null; model?: string | null } = {}) {
    this.usage = init.usage ?? usage();
    this.provider = init.provider ?? null;
    this.model = init.model ?? null;
    Object.freeze(this);
  }

  merge(next: Usage, provider: string | null, model: string | null): NodeCost {
    const first = this.usage.inputTokens + this.usage.outputTokens === 0;
    const same = first || (this.provider === provider && this.model === model);
    return new NodeCost({
      usage: combineUsage(this.usage, next) ?? usage(),
      provider: same ? provider : null,
      model: same ? model : null,
    });
  }
}
export class RunResult {
  readonly outputs: Record<string, unknown> = {};
  readonly faults: string[] = [];
  nullCount = 0;
  validationRetries = 0;
  capTrips = 0;
  engineFaults = 0;
  nodesTotal = 0;
  tokensIn = 0;
  tokensOut = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  reasoningTokens = 0;
  readonly nodeCosts: Record<string, NodeCost> = {};
  forcingFallbacks = 0;
  status: RunStatus = "complete";
  pauseReason: string | null = null;
  pauseFault: string | null = null;
  retryAfter: number | null = null;
  checkpoint: Readonly<Record<string, unknown>> | null = null;

  get nullRate(): number {
    return this.nodesTotal === 0 ? 0 : this.nullCount / this.nodesTotal;
  }
}

export function deriveStatus(result: RunResult): RunStatus {
  if (result.nodesTotal > 0 && result.nullCount >= result.nodesTotal) return "failed";
  if (result.faults.length > 0 || result.nullCount > 0) return "degraded";
  return "complete";
}

export function addUsageToResult(
  result: RunResult,
  nodeId: string,
  next: Usage,
  provider: string | null,
  model: string | null,
): void {
  result.tokensIn += next.inputTokens;
  result.tokensOut += next.outputTokens;
  result.cacheReadTokens += next.cacheReadTokens;
  result.cacheWriteTokens += next.cacheWriteTokens;
  result.reasoningTokens += next.reasoningTokens;
  result.nodeCosts[nodeId] = (result.nodeCosts[nodeId] ?? new NodeCost()).merge(
    next,
    provider,
    model,
  );
}
