/** OpenAI Responses API wire shapes — mirrors `lohra/server/responses.py`.
 * Every SDK-required field is present; streaming carries `sequence_number`
 * and the output-item/content-part `added` events the SDK stream consumer
 * indexes into: created -> output_item.added -> content_part.added ->
 * output_text.delta* -> completed|failed. */

import { CompletionError } from "./chat-format.js";
import { pythonJsonDumpsInsertionOrder } from "../serialization/python-json.js";
import type { OpenAiUsage } from "./usage.js";

const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is Readonly<Record<string, unknown>> =>
          typeof part === "object" &&
          part !== null &&
          TEXT_PART_TYPES.has((part as Record<string, unknown>)["type"] as string),
      )
      .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  return "";
}

export function parseResponsesInput(
  input: string | readonly Readonly<Record<string, unknown>>[],
  instructions: string | null,
): readonly Readonly<Record<string, unknown>>[] {
  const messages: Record<string, unknown>[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });

  if (typeof input === "string") {
    if (input === "") throw new CompletionError("'input' must not be empty");
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    if (input.length === 0) throw new CompletionError("'input' must not be empty");
    for (const item of input) {
      if (typeof item !== "object" || item === null || !("role" in item))
        throw new CompletionError("each input item needs a 'role' and 'content'");
      messages.push({
        role: (item as Record<string, unknown>)["role"],
        content: contentText((item as Record<string, unknown>)["content"]),
      });
    }
  } else {
    throw new CompletionError("'input' must be a string or a list of items");
  }
  return messages;
}

function messageItem(responseId: string, content: string, status: string): Record<string, unknown> {
  return {
    type: "message",
    id: `msg_${responseId}`,
    status,
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  };
}

function responsesUsage(usage: OpenAiUsage): Record<string, unknown> {
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details.cached_tokens,
      cache_write_tokens: usage.prompt_tokens_details.cache_write_tokens,
    },
    output_tokens: usage.completion_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details.reasoning_tokens,
    },
    total_tokens: usage.total_tokens,
  };
}

export function buildResponseObject(options: {
  readonly responseId: string;
  readonly model: string;
  readonly content: string;
  readonly status: "completed" | "failed";
  readonly usage: OpenAiUsage;
  readonly created: number;
  readonly error?: { readonly code: string; readonly message: string } | null;
}): Record<string, unknown> {
  return {
    id: options.responseId,
    object: "response",
    created_at: options.created,
    status: options.status,
    model: options.model,
    output:
      options.content || options.status === "completed"
        ? [messageItem(options.responseId, options.content, "completed")]
        : [],
    output_text: options.content,
    error: options.error ?? null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: responsesUsage(options.usage),
  };
}

function responsesSse(eventType: string, payload: Readonly<Record<string, unknown>>): string {
  return `event: ${eventType}\ndata: ${pythonJsonDumpsInsertionOrder(payload)}\n\n`;
}

export function buildResponseCreatedEvent(options: {
  readonly responseId: string;
  readonly model: string;
  readonly created: number;
  readonly sequenceNumber: number;
}): string {
  const response = {
    id: options.responseId,
    object: "response",
    created_at: options.created,
    status: "in_progress",
    model: options.model,
    output: [],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
  };
  return responsesSse("response.created", {
    type: "response.created",
    sequence_number: options.sequenceNumber,
    response,
  });
}

export function buildOutputItemAddedEvent(options: {
  readonly responseId: string;
  readonly sequenceNumber: number;
}): string {
  return responsesSse("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: options.sequenceNumber,
    output_index: 0,
    item: {
      type: "message",
      id: `msg_${options.responseId}`,
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
}

export function buildContentPartAddedEvent(options: {
  readonly responseId: string;
  readonly sequenceNumber: number;
}): string {
  return responsesSse("response.content_part.added", {
    type: "response.content_part.added",
    sequence_number: options.sequenceNumber,
    item_id: `msg_${options.responseId}`,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
}

export function buildTextDeltaEvent(options: {
  readonly responseId: string;
  readonly delta: string;
  readonly sequenceNumber: number;
}): string {
  return responsesSse("response.output_text.delta", {
    type: "response.output_text.delta",
    sequence_number: options.sequenceNumber,
    item_id: `msg_${options.responseId}`,
    output_index: 0,
    content_index: 0,
    delta: options.delta,
    logprobs: [],
  });
}

export function buildResponseCompletedEvent(
  response: Readonly<Record<string, unknown>>,
  options: { readonly sequenceNumber: number },
): string {
  return responsesSse("response.completed", {
    type: "response.completed",
    sequence_number: options.sequenceNumber,
    response,
  });
}

export function buildResponseFailedEvent(
  response: Readonly<Record<string, unknown>>,
  options: { readonly sequenceNumber: number },
): string {
  return responsesSse("response.failed", {
    type: "response.failed",
    sequence_number: options.sequenceNumber,
    response,
  });
}
