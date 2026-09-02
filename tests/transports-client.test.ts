import { describe, expect, it, vi } from "vitest";

import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  NativeChatHttpPort,
  ProviderCallFailed,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";

const encoder = new TextEncoder();

function response(
  status: number,
  body: unknown,
  contentType = "application/json",
): HttpResponseData {
  return {
    status,
    headers: new Headers({ "content-type": contentType }),
    body: encoder.encode(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function responseWithHeaders(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string>,
): HttpResponseData {
  const data = response(status, body);
  for (const [key, value] of Object.entries(extraHeaders)) data.headers.set(key, value);
  return data;
}

class QueuePort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly queue: Array<HttpResponseData | Error>) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    const value = this.queue.shift();
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new Error("queue exhausted"));
    return Promise.resolve(value);
  }
}

const raw = (text: string): unknown => ({
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

describe("ChatCompletionsClient", () => {
  it("posts and normalizes a non-stream response", async () => {
    const port = new QueuePort([response(200, raw("ab"))]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "lohra-local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const result = await client.create({ model: "m", messages: [], tools: undefined });
    expect(result).toMatchObject({ content: "ab", finishReason: "stop" });
    expect(port.requests).toHaveLength(1);
    expect(JSON.parse(port.requests[0]?.body ?? "null")).toEqual({ model: "m", messages: [] });
    expect(port.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(port.requests[0]?.headers).toEqual({
      authorization: "Bearer lohra-local",
      accept: "application/json",
      "content-type": "application/json",
      "x-stainless-retry-count": "0",
    });
  });

  it("folds SSE without DONE and keeps reasoning callback-only", async () => {
    const frames = [
      { choices: [{ delta: { content: "a", reasoning_content: "r" }, finish_reason: null }] },
      { choices: [{ delta: { content: "b" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("");
    const port = new QueuePort([response(200, frames, "text/event-stream")]);
    const reasoning = vi.fn();
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const result = await client.stream({ model: "m", messages: [] }, { onReasoning: reasoning });
    expect(result).toMatchObject({ content: "ab", reasoning: null });
    expect(reasoning).toHaveBeenCalledWith("r");
    expect(JSON.parse(port.requests[0]?.body ?? "null")).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("parses tool-call deltas split across SSE frames", async () => {
    const frames = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_sse",
                  type: "function",
                  function: { name: "read_file", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":"tool-target.txt"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("");
    const port = new QueuePort([response(200, frames, "text/event-stream")]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    await expect(client.stream({ model: "m", messages: [] })).resolves.toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_sse",
          name: "read_file",
          arguments: '{"path":"tool-target.txt"}',
        },
      ],
    });
  });

  it("retries any exact stream_options prose without that field", async () => {
    const port = new QueuePort([
      response(400, { error: { message: "'stream_options' is not supported" } }),
      response(
        200,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        "text/event-stream",
      ),
    ]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    expect(await client.stream({ model: "m", messages: [] })).toMatchObject({ content: "ok" });
    expect(port.requests).toHaveLength(2);
    expect(JSON.parse(port.requests[0]?.body ?? "null")).toHaveProperty("stream_options");
    expect(JSON.parse(port.requests[1]?.body ?? "null")).not.toHaveProperty("stream_options");
  });

  it("also retries timeout prose containing stream_options", async () => {
    const port = new QueuePort([
      new Error("timeout while sending stream_options"),
      response(
        200,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "text/event-stream",
      ),
    ]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    await expect(client.stream({ model: "m", messages: [] })).resolves.toMatchObject({
      content: "ok",
    });
    expect(port.requests).toHaveLength(2);
  });

  it("bounds 500 retries at three requests and never retries 401", async () => {
    const serverError = () => response(500, { error: { message: "stub: internal error" } });
    const port500 = new QueuePort([serverError(), serverError(), serverError()]);
    const client500 = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port500,
    });
    await expect(client500.create({ model: "m", messages: [] })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(port500.requests).toHaveLength(3);
    expect(port500.requests.map((request) => request.headers["x-stainless-retry-count"])).toEqual([
      "0",
      "1",
      "2",
    ]);

    const port401 = new QueuePort([response(401, { error: { message: "bad key" } })]);
    const client401 = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port401,
    });
    await expect(client401.create({ model: "m", messages: [] })).rejects.toBeInstanceOf(
      ProviderCallFailed,
    );
    expect(port401.requests).toHaveLength(1);
  });

  // T10 fixup: the oracle's OpenAIClient/ResponsesClient delegate retry
  // policy entirely to the openai SDK, which — unlike this client before
  // this fix — retries 429 (up to maxRetries), honors a numeric Retry-After
  // literally, and disarms retry outright when Retry-After parses but
  // exceeds 120s. [fio] measured directly against the real installed SDK
  // (openai 3.6.0) via a local HTTP stub; see errors.ts's openAiRetryPolicy.
  describe("429 retry policy (openai SDK parity)", () => {
    it("retries a 429 up to maxRetries, same as a 500", async () => {
      const quota = () => response(429, { error: { message: "rate limited" } });
      const port = new QueuePort([quota(), quota(), quota()]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      vi.useFakeTimers();
      try {
        const pending = expect(client.create({ model: "m", messages: [] })).rejects.toMatchObject({
          statusCode: 429,
        });
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(port.requests).toHaveLength(3);
    });

    it("honors a numeric Retry-After as the literal backoff delay", async () => {
      const port = new QueuePort([
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "retry-after": "7" }),
        response(200, raw("ok")),
      ]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      vi.useFakeTimers();
      try {
        const pending = client.create({ model: "m", messages: [] });
        await vi.advanceTimersByTimeAsync(6_999);
        expect(port.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(port.requests).toHaveLength(2);
        await expect(pending).resolves.toMatchObject({ content: "ok" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("disarms retry outright when Retry-After exceeds the 120s cap", async () => {
      const farFuture = new Date(Date.now() + 300_000).toUTCString();
      const port = new QueuePort([
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "retry-after": farFuture }),
      ]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      await expect(client.create({ model: "m", messages: [] })).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(port.requests).toHaveLength(1);
    });

    it("does not disarm on a Retry-After that fails to parse at all", async () => {
      const quota = () =>
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "retry-after": "banana" });
      const port = new QueuePort([quota(), quota(), quota()]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      vi.useFakeTimers();
      try {
        const pending = expect(client.create({ model: "m", messages: [] })).rejects.toMatchObject({
          statusCode: 429,
        });
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(port.requests).toHaveLength(3);
    });

    it("honors an explicit x-should-retry: false override on an otherwise-eligible 429", async () => {
      const port = new QueuePort([
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "x-should-retry": "false" }),
      ]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      await expect(client.create({ model: "m", messages: [] })).rejects.toMatchObject({
        statusCode: 429,
      });
      expect(port.requests).toHaveLength(1);
    });

    it("treats Retry-After: 0 as unhonored (falls to backoff, still retries)", async () => {
      const port = new QueuePort([
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "retry-after": "0" }),
        response(200, raw("ok")),
      ]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      vi.useFakeTimers();
      try {
        const pending = client.create({ model: "m", messages: [] });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ content: "ok" });
      } finally {
        vi.useRealTimers();
      }
      expect(port.requests).toHaveLength(2);
    });

    it("never retries a connection-level exception (status-code eligibility only)", async () => {
      const port = new QueuePort([new Error("ECONNRESET"), response(200, raw("ok"))]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      await expect(client.create({ model: "m", messages: [] })).rejects.toThrow("ECONNRESET");
      expect(port.requests).toHaveLength(1);
    });

    it("aborts an honored Retry-After sleep promptly instead of waiting it out", async () => {
      const port = new QueuePort([
        responseWithHeaders(429, { error: { message: "rate limited" } }, { "retry-after": "30" }),
      ]);
      const client = new ChatCompletionsClient({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local",
        transport: new ChatCompletionsTransport(),
        http: port,
      });
      const controller = new AbortController();
      const pending = client.create({ model: "m", messages: [] }, controller.signal);
      queueMicrotask(() => {
        controller.abort(new Error("CLIENT_DISCONNECTED"));
      });
      await expect(pending).rejects.toThrow("CLIENT_DISCONNECTED");
      expect(port.requests).toHaveLength(1);
    });
  });

  it("close is idempotent and rejects future calls", async () => {
    const port = new QueuePort([]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    await client.close();
    await client.close();
    await expect(client.create({ model: "m", messages: [] })).rejects.toThrow("CLIENT_CLOSED");
  });
});

describe("NativeChatHttpPort", () => {
  it("fails closed when the response exceeds its byte cap", async () => {
    const fetcher: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response("12345", { status: 200 })),
    );
    const port = new NativeChatHttpPort(fetcher);
    await expect(
      port.post({
        url: "http://localhost:11434/v1/chat/completions",
        headers: {},
        body: "{}",
        timeoutMs: 100,
        maxBytes: 4,
      }),
    ).rejects.toThrow("RESPONSE_TOO_LARGE");
  });

  it("aborts a fetch that exceeds the request timeout", async () => {
    const fetcher: typeof fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("REQUEST_TIMEOUT"));
          });
        }),
    );
    const port = new NativeChatHttpPort(fetcher);
    await expect(
      port.post({
        url: "http://localhost:11434/v1/chat/completions",
        headers: {},
        body: "{}",
        timeoutMs: 5,
        maxBytes: 100,
      }),
    ).rejects.toThrow("REQUEST_TIMEOUT");
  });
});
