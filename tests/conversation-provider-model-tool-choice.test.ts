// Issue #578 (AC 2): the `ModelRequest` produced by `ConversationRuntime.
// runTurn` (see `tests/conversation-runtime-forced-tool.test.ts`) has to
// reach each of the three `ModelTransport` wrappers' own `buildKwargs` call
// as `toolChoice` — every adapter (`chat-completions.ts`/`anthropic-
// messages.ts`/`responses.ts`) already emits the right per-provider
// `tool_choice` shape once it gets it (pre-existing, unchanged by this
// issue); what was missing is `ChatCompletionsModel`/`AnthropicMessagesModel`/
// `ResponsesModel` themselves forwarding `request.toolChoice` into that
// call at all. Molded on `tests/conversation-model-effort.test.ts`'s own
// per-transport shape for the same kind of additive field.
import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  ResponsesModel,
} from "../src/conversation/index.js";
import type { ModelRequest } from "../src/conversation/index.js";
import {
  AnthropicMessagesClient,
  AnthropicMessagesTransport,
  ChatCompletionsClient,
  ChatCompletionsTransport,
  ResponsesClient,
  ResponsesTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
} from "../src/transports/index.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

class QueueHttp implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly bodies: readonly Uint8Array[]) {}
  post(request: ChatHttpRequest) {
    this.requests.push(request);
    return Promise.resolve({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: this.bodies[this.requests.length - 1] ?? encode(""),
    });
  }
}

function baseRequest(toolChoice: string | null): ModelRequest {
  return {
    system: "sys",
    messages: [],
    model: "m",
    temperature: null,
    effort: null,
    toolChoice,
    maxTokens: null,
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("ModelTransport toolChoice forwarding (#578 — no ModelRequest.toolChoice field existed before)", () => {
  it("ChatCompletionsModel forwards toolChoice as tool_choice:{type:function,function:{name}}, absent when null", async () => {
    const sse = (text: string): Uint8Array =>
      encode(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
          "",
        ].join("\n\n"),
      );
    const http = new QueueHttp([sse("a"), sse("b")]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http,
    });
    const model = new ChatCompletionsModel(client, true);

    await model.complete(baseRequest("StructuredOutput"));
    await model.complete(baseRequest(null));

    const withChoice = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    const withoutChoice = JSON.parse(http.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(withChoice.tool_choice).toEqual({
      type: "function",
      function: { name: "StructuredOutput" },
    });
    expect(withoutChoice).not.toHaveProperty("tool_choice");
  });

  it("AnthropicMessagesModel forwards toolChoice as tool_choice:{type:tool,name}, absent when null", async () => {
    const sse = encode(
      [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        "",
      ].join("\n\n"),
    );
    const http = new QueueHttp([sse]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    const model = new AnthropicMessagesModel(client, true);

    await model.complete(baseRequest("StructuredOutput"));

    const body = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: "tool", name: "StructuredOutput" });
  });

  it("AnthropicMessagesModel sends no tool_choice at all when toolChoice is null", async () => {
    const sse = encode(
      [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        "",
      ].join("\n\n"),
    );
    const http = new QueueHttp([sse]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    const model = new AnthropicMessagesModel(client, true);

    await model.complete(baseRequest(null));

    const body = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("ResponsesModel forwards toolChoice as tool_choice:{type:function,name}, absent when null", async () => {
    const sse = (text: string): Uint8Array =>
      encode(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}`,
          "",
        ].join("\n\n"),
      );
    const http = new QueueHttp([sse("a"), sse("b")]);
    const client = new ResponsesClient({
      baseUrl: "http://127.0.0.1:9",
      token: "k",
      accountId: "acct",
      transport: new ResponsesTransport(),
      http,
    });
    const model = new ResponsesModel(client);

    await model.complete(baseRequest("StructuredOutput"));
    await model.complete(baseRequest(null));

    const withChoice = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    const withoutChoice = JSON.parse(http.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(withChoice.tool_choice).toEqual({ type: "function", name: "StructuredOutput" });
    expect(withoutChoice).not.toHaveProperty("tool_choice");
  });
});
