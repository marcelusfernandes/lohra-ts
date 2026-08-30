import { describe, expect, it, vi } from "vitest";

import { pythonJsonLoads } from "../src/serialization/python-json.js";
import {
  AnthropicMessagesClient,
  AnthropicMessagesTransport,
  ProviderCallFailed,
  ResponsesClient,
  ResponsesTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
} from "../src/transports/index.js";

const body = (value: string): Uint8Array => new TextEncoder().encode(value);

class QueueHttp implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly bodies: readonly Uint8Array[]) {}
  post(request: ChatHttpRequest) {
    this.requests.push(request);
    return Promise.resolve({
      status: 200,
      headers: new Headers(),
      body: this.bodies[this.requests.length - 1] ?? body(""),
    });
  }
}

describe("AnthropicMessagesClient", () => {
  it("uses Messages headers and streams without stream_options", async () => {
    const http = new QueueHttp([
      body(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          "",
        ].join("\n\n"),
      ),
    ]);
    const onText = vi.fn();
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "dummy",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    expect(
      await client.stream({ model: "m", messages: [], max_tokens: 1 }, { onText }),
    ).toMatchObject({
      content: "ok",
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(http.requests[0]).toMatchObject({
      url: "http://127.0.0.1:9/v1/messages",
      headers: { "x-api-key": "dummy", "anthropic-version": "2023-06-01" },
    });
    expect(JSON.parse(http.requests[0]?.body ?? "{}")).toMatchObject({ stream: true });
    expect(JSON.parse(http.requests[0]?.body ?? "{}")).not.toHaveProperty("stream_options");
    expect(onText).toHaveBeenCalledWith("ok");
  });

  it("fails missing auth before a POST", async () => {
    const http = new QueueHttp([]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    await expect(client.create({ model: "m", messages: [], max_tokens: 1 })).rejects.toThrow(
      '"Could not resolve authentication method.',
    );
    expect(http.requests).toEqual([]);
  });

  it("emits Python float tokens in replayed Anthropic tool inputs", async () => {
    const http = new QueueHttp([
      body('{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{}}'),
    ]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "dummy",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    await client.create({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "terminal",
              input: pythonJsonLoads(
                '{"timeout":1.0,"ratio":2.5,"count":7,"since_ns":1788107097189000000}',
              ),
            },
          ],
        },
      ],
      max_tokens: 1,
    });
    expect(http.requests[0]?.body).toContain(
      '"input":{"timeout":1.0,"ratio":2.5,"count":7,"since_ns":1788107097189000000}',
    );
  });

  it("preserves numeric kinds in streamed Anthropic tool input deltas", async () => {
    const http = new QueueHttp([
      body(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"terminal","input":{}}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"timeout\\":1.0,\\"ratio\\":2.5,\\"count\\":7,\\"since_ns\\":1788107097189000000}"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
          "",
        ].join("\n\n"),
      ),
    ]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "dummy",
      transport: new AnthropicMessagesTransport(),
      http,
    });
    const normalized = await client.stream({ model: "m", messages: [], max_tokens: 1 });
    expect(normalized.toolCalls[0]?.arguments).toBe(
      '{"timeout": 1.0, "ratio": 2.5, "count": 7, "since_ns": 1788107097189000000}',
    );
  });
});

describe("ResponsesClient", () => {
  it("always streams with subscription headers and reconstructs output_item.done", async () => {
    const http = new QueueHttp([
      body(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}',
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1}}}',
          "",
        ].join("\n\n"),
      ),
    ]);
    const client = new ResponsesClient({
      baseUrl: "http://127.0.0.1:9",
      token: "dummy",
      accountId: "acct",
      transport: new ResponsesTransport(),
      http,
    });
    expect(await client.create({ model: "m", input: [], store: false })).toMatchObject({
      content: "ok",
      finishReason: "stop",
    });
    expect(http.requests[0]).toMatchObject({
      url: "http://127.0.0.1:9/responses",
      headers: {
        authorization: "Bearer dummy",
        originator: "codex_cli_rs",
        "ChatGPT-Account-ID": "acct",
      },
    });
    expect(JSON.parse(http.requests[0]?.body ?? "{}")).toMatchObject({
      store: false,
      stream: true,
    });
  });

  it("raises a coded ProviderCallFailed and preserves the double space without code", async () => {
    const http = new QueueHttp([
      body('data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n'),
    ]);
    const client = new ResponsesClient({
      baseUrl: "http://127.0.0.1:9",
      token: "dummy",
      transport: new ResponsesTransport(),
      http,
    });
    await expect(client.create({ model: "m", input: [] })).rejects.toEqual(
      expect.objectContaining({
        name: "ProviderCallFailed",
        message: "Responses API failed:  boom",
        code: undefined,
      } satisfies Partial<ProviderCallFailed>),
    );
  });
});
