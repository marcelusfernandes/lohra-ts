import type { Usage } from "./types.js";
function checked(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("USAGE_INTEGER_INVALID");
  return value;
}
export function usage(value: Partial<Usage> = {}): Usage {
  return Object.freeze({
    inputTokens: checked(value.inputTokens ?? 0),
    outputTokens: checked(value.outputTokens ?? 0),
    cacheReadTokens: checked(value.cacheReadTokens ?? 0),
    cacheWriteTokens: checked(value.cacheWriteTokens ?? 0),
    reasoningTokens: checked(value.reasoningTokens ?? 0),
  });
}
export function combineUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (a === null) return b;
  if (b === null) return a;
  return usage({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  });
}
