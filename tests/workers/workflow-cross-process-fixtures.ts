// Shared between `workflow-launch-worker.ts` (process A) and
// `workflow-resume-worker.ts` (process C, issue #103): the spec object must
// be byte-identical in both processes because `WorkflowEngine`'s node-cache
// hash (`engine.ts` `runAgent`, `this.cell([node.id, "agent", prompt, ...])`)
// folds in the spec name/version and the node's own fields — a resumed run
// that built a slightly different spec would simply miss the cache instead
// of proving durability. Importing one constant from here, rather than two
// hand-copied literals, is what makes that identity a fact instead of a
// convention.
export const PROMPT_FIRST = "produce-first";
export const PROMPT_SECOND = "produce-second";

export function crossProcessSpec(): Record<string, unknown> {
  return {
    meta: { name: "cross-process-103" },
    nodes: [
      { id: "first", type: "agent", prompt: PROMPT_FIRST },
      { id: "second", type: "agent", prompt: PROMPT_SECOND, depends_on: ["first"] },
    ],
  };
}

/** A `ChildRunner`-shaped `CollectResult` (`orchestration/core.ts`) for a
 * leaf that completes cleanly with a non-empty output — `cachePut` (engine.ts
 * `runAgent`) skips empty output, so this must never be `""`. */
export function completeResult(output: string): {
  readonly status: "complete";
  readonly output: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly forcedFallback: false;
  readonly errorKind: null;
  readonly retryAfter: null;
} {
  return {
    status: "complete",
    output,
    tokensIn: 1,
    tokensOut: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    provider: "test",
    model: "test-model",
    forcedFallback: false,
    errorKind: null,
    retryAfter: null,
  };
}
