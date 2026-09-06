import { describe, expect, it, vi } from "vitest";

import { parseJsonPreservingNumbers } from "../src/serialization/json-numbers.js";
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

class QueueStatusHttp implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(
    private readonly responses: ReadonlyArray<{
      status: number;
      headers?: Record<string, string>;
      body?: Uint8Array;
    }>,
  ) {}
  post(request: ChatHttpRequest) {
    const next = this.responses[this.requests.length];
    this.requests.push(request);
    if (next === undefined) return Promise.reject(new Error("queue exhausted"));
    return Promise.resolve({
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      body: next.body ?? body('{"error":{"message":"rate limited"}}'),
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
              input: parseJsonPreservingNumbers(
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

  // T10 fixup: the oracle's AnthropicClient delegates retry policy to the
  // anthropic SDK, which genuinely diverges from openai's here — [fio]
  // measured directly against the real installed SDK (anthropic 1.2.0): it
  // retries 429 like a 500, but unlike openai's SDK it never disarms on a
  // Retry-After that exceeds its cap (60s here vs openai's 120s) — it just
  // falls back to backoff instead of honoring the value literally. See
  // errors.ts's anthropicRetryPolicy.
  describe("429 retry policy (anthropic SDK parity)", () => {
    const success = body(
      '{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{}}',
    );

    it("retries a 429 up to maxRetries, same as a 500", async () => {
      const http = new QueueStatusHttp([{ status: 429 }, { status: 429 }, { status: 429 }]);
      const client = new AnthropicMessagesClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "dummy",
        transport: new AnthropicMessagesTransport(),
        http,
      });
      vi.useFakeTimers();
      try {
        const pending = expect(
          client.create({ model: "m", messages: [], max_tokens: 1 }),
        ).rejects.toMatchObject({ statusCode: 429 });
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(http.requests).toHaveLength(3);
    });

    it("does NOT disarm when Retry-After exceeds its cap, unlike openai", async () => {
      const farFuture = new Date(Date.now() + 300_000).toUTCString();
      const http = new QueueStatusHttp([
        { status: 429, headers: { "retry-after": farFuture } },
        { status: 429, headers: { "retry-after": farFuture } },
        { status: 200, body: success },
      ]);
      const client = new AnthropicMessagesClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "dummy",
        transport: new AnthropicMessagesTransport(),
        http,
      });
      vi.useFakeTimers();
      try {
        const pending = client.create({ model: "m", messages: [], max_tokens: 1 });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ content: "ok" });
      } finally {
        vi.useRealTimers();
      }
      expect(http.requests).toHaveLength(3);
    });

    it("honors a numeric Retry-After up to its 60s cap as the literal delay", async () => {
      const http = new QueueStatusHttp([
        { status: 429, headers: { "retry-after": "5" } },
        { status: 200, body: success },
      ]);
      const client = new AnthropicMessagesClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "dummy",
        transport: new AnthropicMessagesTransport(),
        http,
      });
      vi.useFakeTimers();
      try {
        const pending = client.create({ model: "m", messages: [], max_tokens: 1 });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(http.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(http.requests).toHaveLength(2);
        await expect(pending).resolves.toMatchObject({ content: "ok" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("honors an explicit x-should-retry: false override on an otherwise-eligible 429", async () => {
      const http = new QueueStatusHttp([{ status: 429, headers: { "x-should-retry": "false" } }]);
      const client = new AnthropicMessagesClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "dummy",
        transport: new AnthropicMessagesTransport(),
        http,
      });
      await expect(
        client.create({ model: "m", messages: [], max_tokens: 1 }),
      ).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(http.requests).toHaveLength(1);
    });
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

  // T10 fixup: ResponsesClient's oracle counterpart also wraps
  // openai.OpenAI (agent/client.py), so it shares the openai SDK's retry
  // policy — same 120s disarm cap as ChatCompletionsClient, not
  // AnthropicMessagesClient's 60s/never-disarm policy.
  describe("429 retry policy (openai SDK parity)", () => {
    it("disarms retry outright when Retry-After exceeds the 120s cap", async () => {
      const farFuture = new Date(Date.now() + 300_000).toUTCString();
      const http = new QueueStatusHttp([{ status: 429, headers: { "retry-after": farFuture } }]);
      const client = new ResponsesClient({
        baseUrl: "http://127.0.0.1:9",
        token: "dummy",
        transport: new ResponsesTransport(),
        http,
      });
      await expect(client.create({ model: "m", input: [] })).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(http.requests).toHaveLength(1);
    });

    it("retries a 429 up to maxRetries when Retry-After is within the cap", async () => {
      const success = body(
        [
          'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{}}}',
          "",
        ].join("\n\n"),
      );
      const http = new QueueStatusHttp([
        { status: 429, headers: { "retry-after": "2" } },
        { status: 200, body: success },
      ]);
      const client = new ResponsesClient({
        baseUrl: "http://127.0.0.1:9",
        token: "dummy",
        transport: new ResponsesTransport(),
        http,
      });
      vi.useFakeTimers();
      try {
        const pending = client.create({ model: "m", input: [] });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ content: "ok" });
      } finally {
        vi.useRealTimers();
      }
      expect(http.requests).toHaveLength(2);
    });
  });
});
