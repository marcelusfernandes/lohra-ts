/** OpenAI Chat Completions wire shapes — mirrors `lohra/server/format.py`.
 * Two serializers on purpose (contract v2 decision 3): non-stream bodies are
 * compact JSON, SSE frames preserve Python `json.dumps` default spacing. */

import {
  jsonStringifyPythonNumbers,
  pythonJsonDumpsInsertionOrder,
} from "../serialization/python-json.js";
import type { OpenAiUsage } from "./usage.js";

export class CompletionError extends Error {}

/** The upstream provider/turn failed (502), not the client's fault. */
export class UpstreamError extends CompletionError {}

export function splitChatMessages(messages: readonly Readonly<Record<string, unknown>>[]): {
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly lastUserText: string;
} {
  if (messages.length === 0) throw new CompletionError("'messages' must not be empty");
  const last = messages[messages.length - 1] as Readonly<Record<string, unknown>>;
  if (last["role"] !== "user") throw new CompletionError("the last message must be a user message");
  const content = last["content"];
  return {
    history: messages.slice(0, -1),
    lastUserText: typeof content === "string" ? content : "",
  };
}

export function buildChatCompletion(options: {
  readonly completionId: string;
  readonly model: string;
  readonly content: string;
  readonly finishReason: "stop" | "length";
  readonly usage: OpenAiUsage;
  readonly created: number;
}): Record<string, unknown> {
  return {
    id: options.completionId,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.content },
        finish_reason: options.finishReason,
      },
    ],
    usage: options.usage,
  };
}

export function buildChunk(options: {
  readonly completionId: string;
  readonly model: string;
  readonly delta: Readonly<Record<string, unknown>>;
  readonly created: number;
  readonly finishReason?: "stop" | "length" | null;
}): Record<string, unknown> {
  return {
    id: options.completionId,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [{ index: 0, delta: options.delta, finish_reason: options.finishReason ?? null }],
  };
}

export function buildUsageChunk(options: {
  readonly completionId: string;
  readonly model: string;
  readonly created: number;
  readonly usage: OpenAiUsage;
}): Record<string, unknown> {
  return {
    id: options.completionId,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: [],
    usage: options.usage,
  };
}

export function buildModelsList(
  modelIds: readonly string[],
  options: { readonly created: number },
): Record<string, unknown> {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: options.created,
      owned_by: "lohra",
    })),
  };
}

/** Compact, no-space JSON — every non-stream response body. */
export function chatCompletionBody(value: unknown): string {
  return jsonStringifyPythonNumbers(value);
}

/** One SSE `data:` line, Python `json.dumps` default spacing. */
export function sseEvent(payload: Readonly<Record<string, unknown>>): string {
  return `data: ${pythonJsonDumpsInsertionOrder(payload)}\n\n`;
}

export function buildDone(): string {
  return "data: [DONE]\n\n";
}
