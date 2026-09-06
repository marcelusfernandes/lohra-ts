/** OpenAI-wire usage projection — mirrors `lohra/server/service.py::_usage`.
 *
 * Two sources: the provider's real token counts (wire-inclusive: OpenAI's
 * `prompt_tokens` covers the WHOLE prompt, cache is a breakdown of it, not a
 * discount from it), or — absent that — a same-shape estimate over the
 * request's own messages, counting non-string content as its JSON.stringify
 * length (ADR 0003 item 5).
 */

import { isEmptyJsonValue } from "../serialization/json-presence.js";
import type { Usage } from "../transports/index.js";

export interface OpenAiUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: {
    readonly cached_tokens: number;
    readonly cache_write_tokens: number;
  };
  readonly completion_tokens_details: { readonly reasoning_tokens: number };
}

function estimateTokens(text: string): number {
  return Math.max(0, Math.floor(text.length / 4));
}

/** `content or ""` — a non-string, truthy content value counts as its
 * JSON.stringify length. */
function stringifyContent(content: unknown): string {
  if (isEmptyJsonValue(content)) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

export function wireUsage(usage: Usage): OpenAiUsage {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

/** Estimate when the provider reported no usage. `messages` must be exactly
 * what the caller wants attributed as "prompt": chat passes the client's raw
 * request array, Responses passes its already-parsed (parts-concatenated)
 * messages — that base difference is the caller's choice, not this function's. */
export function estimateUsage(
  messages: readonly Readonly<Record<string, unknown>>[],
  content: string,
): OpenAiUsage {
  const promptText = messages.map((message) => stringifyContent(message["content"])).join("");
  const promptTokens = estimateTokens(promptText);
  const completionTokens = Math.max(1, estimateTokens(content));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}
