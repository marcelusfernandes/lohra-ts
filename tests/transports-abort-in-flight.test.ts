import { describe, expect, it, vi } from "vitest";

import {
  AnthropicMessagesClient,
  AnthropicMessagesTransport,
  ChatCompletionsClient,
  ChatCompletionsTransport,
  NativeChatHttpPort,
  ResponsesClient,
  ResponsesTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import {
  AnthropicMessagesModel,
  ChatCompletionsModel,
  type ModelRequest,
} from "../src/conversation/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sse = (frames: readonly unknown[]): Uint8Array =>
  encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
};

/** A `ChatHttpPort` whose `post()` never settles on its own — it only
 * rejects once `request.signal` fires, with whatever error the caller
 * supplies. Models the `NativeChatHttpPort` abort contract (ADR 0005)
 * without a real socket or a real fetch. */
class AbortOnlyPort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly buildError: () => Error) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          reject(this.buildError());
        },
        { once: true },
      );
    });
  }
}

describe("stream() abort in flight (ADR 0005)", () => {
  it("ChatCompletionsClient.stream forwards signal, rejects with StreamAbortedError, and replays the partial text first", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const partialBody = sse([
      {
        choices: [{ index: 0, delta: { content: "parcial" }, finish_reason: null }],
      },
    ]);
    const port = new AbortOnlyPort(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
    );
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = client.stream(
      { model: "m", messages: [] },
      { onText: (text) => received.push(text) },
      controller.signal,
    );
    controller.abort(new Error("USER_CANCELLED"));

    expect(port.requests[0]?.signal).toBe(controller.signal);
    await expect(pending).rejects.toBeInstanceOf(StreamAbortedError);
    expect(received.join("")).toBe("parcial");
    const error = await pending.catch((caught: unknown) => caught);
    expect((error as InstanceType<typeof StreamAbortedError>).partial.text).toBe("parcial");
  });

  it("AnthropicMessagesClient.stream forwards signal, replays partial text, and fills partial.usage from message_start", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const partialBody = sse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "parcial" },
      },
    ]);
    const port = new AbortOnlyPort(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
    );
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new AnthropicMessagesTransport(),
      http: port,
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = client.stream(
      { model: "m", messages: [], max_tokens: 1 },
      { onText: (text) => received.push(text) },
      controller.signal,
    );
    controller.abort(new Error("USER_CANCELLED"));

    expect(port.requests[0]?.signal).toBe(controller.signal);
    await expect(pending).rejects.toBeInstanceOf(StreamAbortedError);
    expect(received.join("")).toBe("parcial");
    const error = await pending.catch((caught: unknown) => caught);
    const partial = (error as InstanceType<typeof StreamAbortedError>).partial;
    expect(partial.text).toBe("parcial");
    expect(partial.usage?.inputTokens).toBe(5);
  });

  it("ResponsesClient.stream forwards signal, replays partial text, and keeps partial.usage null (no message_start frame exists)", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const partialBody = sse([{ type: "response.output_text.delta", delta: "parcial" }]);
    const port = new AbortOnlyPort(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
    );
    const client = new ResponsesClient({
      baseUrl: "http://127.0.0.1:9",
      token: "k",
      transport: new ResponsesTransport(),
      http: port,
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = client.stream(
      { model: "m", input: [] },
      { onText: (text) => received.push(text) },
      controller.signal,
    );
    controller.abort(new Error("USER_CANCELLED"));

    expect(port.requests[0]?.signal).toBe(controller.signal);
    await expect(pending).rejects.toBeInstanceOf(StreamAbortedError);
    expect(received.join("")).toBe("parcial");
    const error = await pending.catch((caught: unknown) => caught);
    const partial = (error as InstanceType<typeof StreamAbortedError>).partial;
    expect(partial.text).toBe("parcial");
    expect(partial.usage).toBeNull();
  });

  it("NativeChatHttpPort(fetcher) cancels an in-flight ReadableStream body on abort and surfaces the partial bytes", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const chunk = encoder.encode("partial-chunk");
    let pulled: (() => void) | undefined;
    const pulledOnce = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    let enqueuedOnce = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!enqueuedOnce) {
          enqueuedOnce = true;
          controller.enqueue(chunk);
          return;
        }
        pulled?.();
        // Never enqueues again and never closes — an in-flight body with
        // more data still "coming".
      },
    });
    const fetcher: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );
    const port = new NativeChatHttpPort(fetcher);
    const controller = new AbortController();
    const pending = port.post({
      url: "http://127.0.0.1:9/x",
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
      maxBytes: 4_000_000,
      signal: controller.signal,
    });

    await pulledOnce;
    controller.abort(new Error("USER_CANCELLED"));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StreamAbortedError);
    expect(decoder.decode((error as InstanceType<typeof StreamAbortedError>).partialBody)).toBe(
      "partial-chunk",
    );
  });

  it("forwards ModelRequest.signal into the streaming branch of both model wrappers", async () => {
    class RecordingPort implements ChatHttpPort {
      readonly requests: ChatHttpRequest[] = [];
      post(request: ChatHttpRequest): Promise<HttpResponseData> {
        this.requests.push(request);
        return Promise.resolve({ status: 200, headers: new Headers(), body: encoder.encode("") });
      }
    }
    const controller = new AbortController();
    const request: ModelRequest = {
      system: "sys",
      messages: [],
      model: "m",
      temperature: null,
      effort: null,
      maxTokens: null,
      tools: [],
      signal: controller.signal,
    };

    const chatPort = new RecordingPort();
    const chatModel = new ChatCompletionsModel(
      new ChatCompletionsClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "k",
        transport: new ChatCompletionsTransport(),
        http: chatPort,
      }),
      true,
    );
    await chatModel.complete(request).catch(() => undefined);
    expect(chatPort.requests[0]?.signal).toBe(controller.signal);

    const anthropicPort = new RecordingPort();
    const anthropicModel = new AnthropicMessagesModel(
      new AnthropicMessagesClient({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "k",
        transport: new AnthropicMessagesTransport(),
        http: anthropicPort,
      }),
      true,
    );
    await anthropicModel.complete(request).catch(() => undefined);
    expect(anthropicPort.requests[0]?.signal).toBe(controller.signal);
  });

  it("ChatCompletionsClient.stream replays the deltas already parsed when the trailing SSE frame is truncated mid-abort (issue #567)", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const completeFrame = sse([
      { choices: [{ index: 0, delta: { content: "completo" }, finish_reason: null }] },
    ]);
    // A `data:` line cut mid-JSON, no terminating `\n\n` — exactly what an
    // abort mid-flight leaves behind in `readBounded`/`postNative`'s
    // captured `partialBody`.
    const truncatedTail = encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"trunc');
    const partialBody = concatBytes(completeFrame, truncatedTail);
    const port = new AbortOnlyPort(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
    );
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const controller = new AbortController();
    const received: string[] = [];
    const pending = client.stream(
      { model: "m", messages: [] },
      { onText: (text) => received.push(text) },
      controller.signal,
    );
    controller.abort(new Error("USER_CANCELLED"));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StreamAbortedError);
    // The completed delta stays — only the truncated trailing frame is
    // discarded, not the whole partial buffer (ADR 0005 amendment #567).
    expect(received.join("")).toBe("completo");
    expect((error as InstanceType<typeof StreamAbortedError>).partial.text).toBe("completo");
  });

  it("NativeChatHttpPort(fetcher).post() rejects with StreamAbortedError, not the raw fetch error, when the signal is already aborted before fetch() is called (issue #567)", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const fetcher: typeof fetch = vi.fn((_input, init?: RequestInit) => {
      if (init?.signal?.aborted === true) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    });
    const port = new NativeChatHttpPort(fetcher);
    const controller = new AbortController();
    controller.abort(new Error("USER_CANCELLED"));

    const error = await port
      .post({
        url: "http://127.0.0.1:9/x",
        headers: {},
        body: "{}",
        timeoutMs: 5_000,
        maxBytes: 4_000_000,
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StreamAbortedError);
    expect((error as InstanceType<typeof StreamAbortedError>).partialBody?.byteLength).toBe(0);
  });

  it("NativeChatHttpPort() (native path) .post() rejects with StreamAbortedError carrying an empty partialBody when the signal is already aborted before the request is sent (issue #567)", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const port = new NativeChatHttpPort();
    const controller = new AbortController();
    controller.abort(new Error("USER_CANCELLED"));

    const error = await port
      .post({
        url: "http://127.0.0.1:9/x",
        headers: {},
        body: "{}",
        timeoutMs: 5_000,
        maxBytes: 4_000_000,
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StreamAbortedError);
    expect((error as InstanceType<typeof StreamAbortedError>).partialBody?.byteLength).toBe(0);
  });
});

describe("stream() without an abort stays byte-identical (contra-assertion)", () => {
  class QueueHttp implements ChatHttpPort {
    readonly requests: ChatHttpRequest[] = [];
    constructor(private readonly body: Uint8Array) {}
    post(request: ChatHttpRequest): Promise<HttpResponseData> {
      this.requests.push(request);
      return Promise.resolve({ status: 200, headers: new Headers(), body: this.body });
    }
  }

  it("ChatCompletionsClient.stream(kwargs, callbacks) with 2 arguments still works and normalizes the same", async () => {
    const body = sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: new QueueHttp(body),
    });
    await expect(client.stream({ model: "m", messages: [] })).resolves.toMatchObject({
      content: "ok",
      finishReason: "stop",
    });
  });

  it("AnthropicMessagesClient.stream with a never-aborted signal normalizes the same as no signal at all", async () => {
    const body = sse([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
    ]);
    const client = new AnthropicMessagesClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new AnthropicMessagesTransport(),
      http: new QueueHttp(body),
    });
    const controller = new AbortController();
    await expect(
      client.stream({ model: "m", messages: [], max_tokens: 1 }, {}, controller.signal),
    ).resolves.toMatchObject({ content: "ok", finishReason: "stop" });
  });

  it("ResponsesClient.stream with a never-aborted signal normalizes the same as before", async () => {
    const body = sse([
      {
        type: "response.completed",
        response: { status: "completed", output: [], usage: {} },
      },
    ]);
    const client = new ResponsesClient({
      baseUrl: "http://127.0.0.1:9",
      token: "k",
      transport: new ResponsesTransport(),
      http: new QueueHttp(body),
    });
    const controller = new AbortController();
    await expect(
      client.stream({ model: "m", input: [] }, {}, controller.signal),
    ).resolves.toMatchObject({ finishReason: "stop" });
  });
});
