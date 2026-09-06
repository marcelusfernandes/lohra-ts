import {
  parseJsonPreservingNumbers,
  stringifyJsonPreservingNumbers,
} from "../serialization/json-numbers.js";
import type {
  BuildKwargsOptions,
  ChatKwargs,
  FinishReason,
  NormalizedResponse,
  ToolCall,
  Usage,
} from "./types.js";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const copy = <T>(value: T): T => structuredClone(value);
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function thinkingBlocks(message: Readonly<Record<string, unknown>>): unknown[] {
  const value = record(message.provider_data).thinking_blocks;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const block = record(item);
    if (block.type === "thinking")
      return { signature: block.signature, thinking: block.thinking, type: "thinking" };
    if (block.type === "redacted_thinking") return { data: block.data, type: "redacted_thinking" };
    return copy(block);
  });
}

function imageBlock(part: Record<string, unknown>): Record<string, unknown> | null {
  const raw = record(part.image_url).url ?? part.image_url;
  if (typeof raw !== "string") return null;
  if (raw.startsWith("data:")) {
    const comma = raw.indexOf(",");
    const header = comma < 0 ? raw.slice(5) : raw.slice(5, comma);
    const mediaType = header.split(";")[0] || "image/png";
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: comma < 0 ? "" : raw.slice(comma + 1),
      },
    };
  }
  return { type: "image", source: { type: "url", url: raw } };
}

function contentBlocks(value: unknown): unknown {
  if (!Array.isArray(value)) return value || "";
  return value.map((raw) => {
    const part = record(raw);
    if (part.type === "image_url") return imageBlock(part) ?? copy(part);
    return copy(part);
  });
}

function assistant(message: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const thinking = thinkingBlocks(message);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (thinking.length === 0 && calls.length === 0 && !Array.isArray(message.content))
    return { role: "assistant", content: message.content || "" };
  const content: unknown[] = [...thinking];
  if (Array.isArray(message.content)) {
    for (const item of message.content as readonly unknown[]) content.push(copy(item));
  }
  if (typeof message.content === "string" && message.content)
    content.push({ type: "text", text: message.content });
  for (const raw of calls) {
    const call = record(raw);
    const fn = record(call.function);
    let input: unknown = {};
    if (typeof fn.arguments === "string") {
      try {
        input = parseJsonPreservingNumbers(fn.arguments);
      } catch {
        input = {};
      }
    }
    content.push({ type: "tool_use", id: call.id, name: fn.name, input: record(input) });
  }
  return { role: "assistant", content };
}

function convertMessages(
  messages: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Readonly<Record<string, unknown>>;
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      output.push(assistant(message));
      continue;
    }
    if (message.role === "tool") {
      const blocks: Record<string, unknown>[] = [];
      let cursor = index;
      while (cursor < messages.length && messages[cursor]?.role === "tool") {
        const tool = messages[cursor] as Readonly<Record<string, unknown>>;
        blocks.push({
          type: "tool_result",
          tool_use_id: tool.tool_call_id,
          content: tool.content || "",
        });
        cursor += 1;
      }
      output.push({ role: "user", content: blocks });
      index = cursor - 1;
      continue;
    }
    output.push({ role: message.role, content: contentBlocks(message.content) });
  }
  return output;
}

function toolDefinition(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (raw.type === "function") {
    const fn = record(raw.function);
    return {
      name: fn.name,
      description: fn.description ?? "",
      input_schema: copy(fn.parameters ?? { type: "object", properties: {} }),
    };
  }
  return copy(raw);
}

function stopReason(value: unknown): FinishReason {
  if (value === "max_tokens" || value === "model_context_window_exceeded") return "length";
  if (value === "tool_use") return "tool_calls";
  if (value === "refusal") return "content_filter";
  if (value === "pause_turn") return "pause";
  return "stop";
}

function normalizeUsage(value: unknown): Usage | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  return {
    inputTokens: number(raw.input_tokens),
    outputTokens: number(raw.output_tokens),
    cacheReadTokens: number(raw.cache_read_input_tokens),
    cacheWriteTokens: number(raw.cache_creation_input_tokens),
    reasoningTokens: 0,
  };
}

export class AnthropicMessagesTransport {
  buildKwargs(options: BuildKwargsOptions): ChatKwargs {
    const systems = [
      options.system,
      ...options.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const result: Record<string, unknown> = {
      model: options.model,
      messages: convertMessages(options.messages),
      max_tokens: options.maxTokens || 4096,
    };
    if (systems.length > 0) result.system = systems.join("\n\n");
    if (options.temperature !== undefined && options.temperature !== null)
      result.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) result.tools = options.tools.map(toolDefinition);
    if (options.toolChoice !== undefined && options.toolChoice !== null)
      result.tool_choice = { type: "tool", name: options.toolChoice };
    return result;
  }

  normalizeResponse(rawValue: unknown): NormalizedResponse {
    const raw = record(rawValue);
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    let text = "";
    let reasoning = "";
    const opaque: Record<string, unknown>[] = [];
    const calls: ToolCall[] = [];
    for (const value of blocks) {
      const block = record(value);
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "thinking") {
        if (typeof block.thinking === "string") reasoning += block.thinking;
        opaque.push({ signature: block.signature, thinking: block.thinking, type: "thinking" });
      } else if (block.type === "redacted_thinking") {
        opaque.push({ data: block.data, type: "redacted_thinking" });
      } else if (block.type === "tool_use") {
        calls.push({
          id: typeof block.id === "string" ? block.id : null,
          name: typeof block.name === "string" ? block.name : "",
          arguments: stringifyJsonPreservingNumbers(record(block.input)),
          providerData: null,
        });
      }
    }
    return {
      content: text || null,
      finishReason: stopReason(raw.stop_reason),
      toolCalls: calls,
      reasoning: reasoning || null,
      usage: normalizeUsage(raw.usage),
      providerData: opaque.length > 0 ? { thinking_blocks: opaque } : null,
    };
  }
}
