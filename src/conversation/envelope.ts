import { pythonFloat, pythonJsonDumpsIndented } from "../serialization/python-json.js";
import type { CostEstimate } from "../pricing/index.js";
import type { ToolCall, Usage } from "../transports/index.js";
import type { ConversationTurnResult, ExecutedToolCall, SessionSummary } from "./types.js";

function usage(value: Usage | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  return {
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    ...(value.cacheReadTokens ? { cache_read_tokens: value.cacheReadTokens } : {}),
    ...(value.cacheWriteTokens ? { cache_write_tokens: value.cacheWriteTokens } : {}),
    ...(value.reasoningTokens ? { reasoning_tokens: value.reasoningTokens } : {}),
  };
}

function cost(value: CostEstimate | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  return {
    usd: pythonFloat(Math.round(value.usd * 1_000_000) / 1_000_000),
    gross_usd: pythonFloat(Math.round(value.grossUsd * 1_000_000) / 1_000_000),
    saved_usd: pythonFloat(Math.round(value.savedUsd * 1_000_000) / 1_000_000),
    basis: value.basis,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.note === undefined ? {} : { note: value.note }),
  };
}

function session(value: SessionSummary): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_tokens: value.cacheReadTokens,
    cache_write_tokens: value.cacheWriteTokens,
    reasoning_tokens: value.reasoningTokens,
    api_call_count: value.apiCallCount,
    priced_call_count: value.pricedCallCount ?? 0,
  };
  if (value.actualCostUsd !== null) {
    result.cost = {
      usd: pythonFloat(Math.round(value.actualCostUsd * 1_000_000) / 1_000_000),
      gross_usd: pythonFloat(
        Math.round((value.estimatedCostUsd ?? value.actualCostUsd) * 1_000_000) / 1_000_000,
      ),
      ...((value.pricedCallCount ?? 0) < value.apiCallCount ? { partial: true } : {}),
    };
  }
  return result;
}

function toolCalls(calls: readonly ToolCall[]): readonly Readonly<Record<string, unknown>>[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    result: null,
  }));
}

function executedToolCalls(
  calls: readonly ExecutedToolCall[],
): readonly Readonly<Record<string, unknown>>[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    result: call.result,
  }));
}

export function successEnvelope(result: ConversationTurnResult): string {
  const value: Record<string, unknown> = {
    session_id: result.sessionId,
    model: result.model,
    temperature: result.temperature === null ? null : pythonFloat(result.temperature),
    input: result.input,
    output: result.response.content,
    reasoning: result.response.reasoning,
    tool_calls:
      (result.toolCalls?.length ?? 0) > 0
        ? executedToolCalls(result.toolCalls ?? [])
        : toolCalls(result.response.toolCalls),
    usage: usage(result.response.usage),
    usage_total: usage(result.usageTotal),
    cost: cost(result.cost),
    stop_reason: result.response.finishReason,
    completed: true,
    error: null,
    api_calls: result.apiCalls,
  };
  if (result.sessionSummary !== null) value.session = session(result.sessionSummary);
  return `${pythonJsonDumpsIndented(value)}\n`;
}

export function errorEnvelope(input: {
  readonly sessionId: string;
  readonly model: string | null;
  readonly prompt: string;
  readonly error: string;
  readonly apiCalls: number;
  readonly usage?: Usage | null;
  readonly usageTotal?: Usage | null;
  readonly cost?: CostEstimate | null;
  readonly sessionSummary?: SessionSummary | null;
  readonly stopReason?: string | null;
  readonly toolCalls?: readonly ExecutedToolCall[];
}): string {
  const value: Record<string, unknown> = {
    session_id: input.sessionId,
    model: input.model,
    temperature: null,
    input: input.prompt,
    output: null,
    reasoning: null,
    tool_calls: executedToolCalls(input.toolCalls ?? []),
    usage: usage(input.usage ?? null),
    usage_total: usage(input.usageTotal ?? input.usage ?? null),
    cost: cost(input.cost ?? null),
    stop_reason: input.stopReason ?? null,
    completed: false,
    error: input.error,
    api_calls: input.apiCalls,
  };
  if (input.sessionSummary !== undefined && input.sessionSummary !== null)
    value.session = session(input.sessionSummary);
  return `${pythonJsonDumpsIndented(value)}\n`;
}
