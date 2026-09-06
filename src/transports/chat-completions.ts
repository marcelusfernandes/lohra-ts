import { stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";
import type {
  BuildKwargsOptions,
  ChatKwargs,
  FinishReason,
  NormalizedResponse,
  ToolCall,
  Usage,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function field(value: unknown, key: string): unknown {
  return record(value)[key];
}

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function cleanAssistant(message: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: "assistant",
    content: message.content ?? null,
  };
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (rawCalls.length > 0) {
    result.tool_calls = rawCalls.map((raw) => {
      const call = record(raw);
      const fn = record(call.function);
      const argumentsValue = fn.arguments;
      return {
        id: call.id,
        type: "function",
        function: {
          name: fn.name,
          arguments:
            typeof argumentsValue === "string"
              ? argumentsValue
              : stringifyJsonPreservingNumbers(argumentsValue || {}),
        },
      };
    });
  }
  return result;
}

function convertMessages(
  messages: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown>[] {
  return messages.map((message) => {
    const role = message.role;
    if (role === "assistant") return cleanAssistant(message);
    if (role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content || "",
      };
    }
    if (role === "system") return { role: "system", content: message.content || "" };
    const content = message.content;
    return {
      role: "user",
      content: Array.isArray(content) ? deepCopy(content) : content || "",
    };
  });
}

function finishReason(value: unknown): FinishReason {
  if (value === "pause") return "pause";
  if (value === "length" || value === "content_filter") return value;
  if (value === "tool_calls" || value === "function_call") return "tool_calls";
  return "stop";
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const call = record(raw);
    const fn = record(call.function);
    return {
      id: typeof call.id === "string" ? call.id : null,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" && fn.arguments ? fn.arguments : "{}",
      providerData: null,
    };
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): Usage | null {
  if (value === null || value === undefined) return null;
  const usage = record(value);
  const prompt = numberOrZero(usage.prompt_tokens);
  const promptDetails = record(usage.prompt_tokens_details);
  let cached = numberOrZero(promptDetails.cached_tokens);
  if (!cached) cached = numberOrZero(usage.cached_tokens);
  cached = Math.min(cached, prompt);
  const completionDetails = record(usage.completion_tokens_details);
  return {
    inputTokens: prompt - cached,
    outputTokens: numberOrZero(usage.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: numberOrZero(completionDetails.reasoning_tokens),
  };
}

export class ChatCompletionsTransport {
  buildKwargs(options: BuildKwargsOptions): ChatKwargs {
    const messages: Record<string, unknown>[] = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push(...convertMessages(options.messages));
    const result: Record<string, unknown> = { model: options.model, messages };
    if (options.maxTokens !== undefined && options.maxTokens !== null)
      result.max_tokens = options.maxTokens;
    if (options.temperature !== undefined && options.temperature !== null)
      result.temperature = options.temperature;
    if (options.effort !== undefined && options.effort !== null)
      result.reasoning_effort = options.effort;
    if (options.tools && options.tools.length > 0) result.tools = deepCopy(options.tools);
    if (options.toolChoice !== undefined && options.toolChoice !== null) {
      result.tool_choice = {
        type: "function",
        function: { name: options.toolChoice },
      };
    }
    return result;
  }

  normalizeResponse(raw: unknown): NormalizedResponse {
    const choices = field(raw, "choices");
    if (!Array.isArray(choices) || choices.length === 0) {
      return {
        content: null,
        finishReason: "stop",
        toolCalls: [],
        reasoning: null,
        usage: null,
        providerData: null,
      };
    }
    const choice = record(choices[0]);
    const message = record(choice.message);
    return {
      content: typeof message.content === "string" ? message.content : null,
      finishReason: finishReason(choice.finish_reason),
      toolCalls: normalizeToolCalls(message.tool_calls),
      reasoning:
        typeof message.reasoning_content === "string" && message.reasoning_content
          ? message.reasoning_content
          : null,
      usage: normalizeUsage(field(raw, "usage")),
      providerData: null,
    };
  }
}
