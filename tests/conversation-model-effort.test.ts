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

function baseRequest(effort: string | null): ModelRequest {
  return {
    system: "sys",
    messages: [],
    model: "m",
    temperature: null,
    effort,
    maxTokens: null,
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("ModelTransport effort forwarding (T13 plumbing — no ModelRequest.effort field existed before)", () => {
  it("ChatCompletionsModel forwards effort as reasoning_effort, absent when null (contract L1/L9)", async () => {
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

    await model.complete(baseRequest("high"));
    await model.complete(baseRequest(null));

    const withEffort = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    const withoutEffort = JSON.parse(http.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(withEffort.reasoning_effort).toBe("high");
    expect(withoutEffort).not.toHaveProperty("reasoning_effort");
  });

  it("ResponsesModel forwards effort as reasoning.effort, absent when null (matches oracle's responses.py)", async () => {
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

    await model.complete(baseRequest("high"));
    await model.complete(baseRequest(null));

    const withEffort = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    const withoutEffort = JSON.parse(http.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect(withEffort.reasoning).toEqual({ effort: "high" });
    expect(withoutEffort).not.toHaveProperty("reasoning");
  });

  it("AnthropicMessagesModel accepts effort as a no-op — matches the oracle's anthropic_messages.py comment exactly", async () => {
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

    const result = await model.complete(baseRequest("high"));

    expect(result.content).toBe("a");
    const body = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
