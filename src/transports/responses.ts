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

function parts(value: unknown, assistant = false): unknown[] {
  if (typeof value === "string")
    return value ? [{ type: assistant ? "output_text" : "input_text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const part = record(raw);
    if (part.type === "text")
      return { type: assistant ? "output_text" : "input_text", text: part.text };
    if (part.type === "image_url") {
      const image = record(part.image_url).url ?? part.image_url;
      return { type: "input_image", image_url: image };
    }
    return copy(part);
  });
}

function convertMessages(
  messages: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const replay = record(message.provider_data).reasoning_items;
      if (Array.isArray(replay)) {
        for (const raw of replay) {
          const item = record(raw);
          if (typeof item.encrypted_content === "string")
            output.push({
              type: "reasoning",
              summary: Array.isArray(item.summary) ? copy(item.summary) : [],
              encrypted_content: item.encrypted_content,
            });
        }
      }
      const assistantText =
        typeof message.content === "string"
          ? message.content
          : parts(message.content, true)
              .map((part) => record(part).text)
              .filter((part): part is string => typeof part === "string")
              .join("");
      if (assistantText) output.push({ role: "assistant", content: assistantText });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const raw of calls) {
        const call = record(raw);
        const fn = record(call.function);
        output.push({
          type: "function_call",
          call_id: call.id,
          name: fn.name,
          arguments: fn.arguments,
        });
      }
      continue;
    }
    if (message.role === "tool") {
      output.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content || "",
      });
      continue;
    }
    const content = Array.isArray(message.content) ? parts(message.content) : message.content || "";
    output.push({ role: message.role || "user", content });
  }
  return output;
}

function tool(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fn = raw.type === "function" ? record(raw.function) : raw;
  return {
    type: "function",
    name: fn.name,
    description: fn.description ?? "",
    parameters: copy(fn.parameters ?? { type: "object", properties: {} }),
  };
}

function normalizeUsage(rawValue: unknown): Usage | null {
  if (rawValue === null || rawValue === undefined) return null;
  const raw = record(rawValue);
  const total = number(raw.input_tokens);
  const cached = Math.min(number(record(raw.input_tokens_details).cached_tokens), total);
  return {
    inputTokens: total - cached,
    outputTokens: number(raw.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: number(record(raw.output_tokens_details).reasoning_tokens),
  };
}

function status(value: unknown): FinishReason {
  return value === "incomplete" ? "length" : "stop";
}

export class ResponsesTransport {
  buildKwargs(options: BuildKwargsOptions): ChatKwargs {
    const systems = [
      options.system,
      ...options.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const result: Record<string, unknown> = {
      model: options.model,
      input: convertMessages(options.messages),
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    if (systems.length > 0) result.instructions = systems.join("\n\n");
    if (options.temperature !== undefined && options.temperature !== null)
      result.temperature = options.temperature;
    if (options.effort !== undefined && options.effort !== null)
      result.reasoning = { effort: options.effort };
    if (options.tools && options.tools.length > 0) result.tools = options.tools.map(tool);
    if (options.toolChoice !== undefined && options.toolChoice !== null)
      result.tool_choice = { type: "function", name: options.toolChoice };
    return result;
  }

  normalizeResponse(rawValue: unknown): NormalizedResponse {
    const raw = record(rawValue);
    const output = Array.isArray(raw.output) ? raw.output : [];
    let content = "";
    let reasoning = "";
    const calls: ToolCall[] = [];
    const replay: Record<string, unknown>[] = [];
    for (const value of output) {
      const item = record(value);
      if (item.type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const part of summary) {
          const text = record(part).text;
          if (typeof text === "string") reasoning += text;
        }
        if (summary.length === 0) {
          if (typeof item.thinking === "string") reasoning += item.thinking;
          else if (typeof item.text === "string") reasoning += item.text;
        }
        if (typeof item.encrypted_content === "string")
          replay.push({
            type: "reasoning",
            summary: summary.map((part) => ({
              type: "summary_text",
              text: typeof record(part).text === "string" ? record(part).text : "",
            })),
            encrypted_content: item.encrypted_content,
          });
      } else if (item.type === "message") {
        const values = Array.isArray(item.content) ? item.content : [];
        for (const partValue of values) {
          const part = record(partValue);
          if (part.type === "output_text" && typeof part.text === "string") content += part.text;
          if (part.type === "refusal" && typeof part.refusal === "string") content += part.refusal;
        }
      } else if (item.type === "function_call") {
        calls.push({
          id: typeof item.call_id === "string" ? item.call_id : null,
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
          providerData: null,
        });
      }
    }
    if (!content && typeof raw.output_text === "string") content = raw.output_text;
    return {
      content: content || null,
      finishReason: calls.length > 0 ? "tool_calls" : status(raw.status),
      toolCalls: calls,
      reasoning: reasoning || null,
      usage: normalizeUsage(raw.usage),
      providerData: replay.length > 0 ? { reasoning_items: replay } : null,
    };
  }
}
