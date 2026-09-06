import { describe, expect, it } from "vitest";

import { CompletionService } from "../src/server/service.js";
import { UpstreamError } from "../src/server/chat-format.js";
import { ProviderCallFailed } from "../src/transports/index.js";
import type { ModelRequest, ModelTransport, ToolDispatcher } from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const usage = {
  inputTokens: 60,
  outputTokens: 7,
  cacheReadTokens: 40,
  cacheWriteTokens: 0,
  reasoningTokens: 3,
} as const;

class StubTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  closes = 0;

  constructor(
    private readonly result: NormalizedResponse | ((request: ModelRequest) => NormalizedResponse),
  ) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    return Promise.resolve(typeof this.result === "function" ? this.result(request) : this.result);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

const okResponse = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "Hello wire",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

describe("CompletionService", () => {
  it("seeds a per-request repository from history and never closes the shared transport", async () => {
    const transport = new StubTransport(okResponse());
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });

    const result = await service.run({
      model: "m",
      history: [
        { role: "user", content: "prior" },
        { role: "assistant", content: "reply" },
      ],
      userText: "hi",
      usageMessages: [{ role: "user", content: "hi" }],
      temperature: null,
      maxTokens: null,
    });

    expect(transport.requests[0]?.messages).toEqual([
      { role: "user", content: "prior" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "hi" },
    ]);
    expect(transport.closes).toBe(0);
    expect(result.model).toBe("m");
    expect(result.content).toBe("Hello wire");
    expect(result.finishReason).toBe("stop");
  });

  it("falls back to the profile default max_tokens when the client omits it (assertion 29a)", async () => {
    const transport = new StubTransport(okResponse());
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });

    await service.run({
      model: "m",
      history: [],
      userText: "hi",
      usageMessages: [],
      temperature: null,
      maxTokens: null,
    });
    expect(transport.requests[0]?.maxTokens).toBe(8192);
  });

  it("passes the client's explicit max_tokens through unchanged (assertion 29a)", async () => {
    const transport = new StubTransport(okResponse());
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });

    await service.run({
      model: "m",
      history: [],
      userText: "hi",
      usageMessages: [],
      temperature: 0.25,
      maxTokens: 77,
    });
    expect(transport.requests[0]?.maxTokens).toBe(77);
    expect(transport.requests[0]?.temperature).toBe(0.25);
  });

  it("maps finishReason: length stays length, everything else collapses to stop", async () => {
    const service = (finishReason: NormalizedResponse["finishReason"]) =>
      new CompletionService({
        transport: new StubTransport(okResponse({ finishReason })),
        streamingTransport: new StubTransport(okResponse({ finishReason })),
        systemPrompt: () => "system",
        provider: "ollama",
        maxIterations: 8,
        defaultMaxTokens: 8192,
      }).run({
        model: "m",
        history: [],
        userText: "hi",
        usageMessages: [],
        temperature: null,
        maxTokens: null,
      });

    expect((await service("length")).finishReason).toBe("length");
    expect((await service("stop")).finishReason).toBe("stop");
    expect((await service("content_filter")).finishReason).toBe("stop");
  });

  it("uses provider-reported usage (wire-inclusive) when present", async () => {
    const transport = new StubTransport(okResponse());
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });
    const result = await service.run({
      model: "m",
      history: [],
      userText: "hi",
      usageMessages: [{ role: "user", content: "hi" }],
      temperature: null,
      maxTokens: null,
    });
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
  });

  it("estimates usage from usageMessages when the provider reports none", async () => {
    const transport = new StubTransport(okResponse({ usage: null, content: "abcdefgh" }));
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });
    const result = await service.run({
      model: "m",
      history: [],
      userText: "ignored for estimate",
      usageMessages: [
        { role: "user", content: "SCEN:nousage seed" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "SCEN:nousage abcd" }] },
      ],
      temperature: null,
      maxTokens: null,
    });
    expect(result.usage.prompt_tokens).toBe(16);
    expect(result.usage.completion_tokens).toBe(2);
  });

  it("forwards onDelta as streaming text deltas", async () => {
    const transport = new StubTransport((request) => {
      request.onText?.("he");
      request.onText?.("llo");
      return okResponse({ content: "hello" });
    });
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });
    const seen: string[] = [];
    await service.run({
      model: "m",
      history: [],
      userText: "hi",
      usageMessages: [],
      temperature: null,
      maxTokens: null,
      onDelta: (delta) => seen.push(delta),
    });
    expect(seen).toEqual(["he", "llo"]);
  });

  it("maps any turn failure to UpstreamError carrying the causal message (502 upstream_error)", async () => {
    const cause = new ProviderCallFailed("refused", {
      statusCode: 418,
      payload: { error: { message: "T11_CAUSE_NONCE42 upstream refused", type: "teapot_error" } },
    });
    const transport: ModelTransport = {
      complete: () => Promise.reject(cause),
      close: () => Promise.resolve(),
    };
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });

    await expect(
      service.run({
        model: "m",
        history: [],
        userText: "hi",
        usageMessages: [],
        temperature: null,
        maxTokens: null,
      }),
    ).rejects.toThrow(
      new UpstreamError(
        'Error code: 418 - {"error":{"message":"T11_CAUSE_NONCE42 upstream refused","type":"teapot_error"}}',
      ),
    );
  });

  it("wires an explicit toolDispatcher/toolDefinitions through to the runtime", async () => {
    let dispatched = false;
    const dispatcher: ToolDispatcher = {
      dispatch: (call) => {
        dispatched = true;
        return Promise.resolve({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: "ok",
        });
      },
    };
    let calls = 0;
    const transport = new StubTransport(() => {
      calls += 1;
      return calls === 1
        ? okResponse({
            content: null,
            finishReason: "tool_calls",
            toolCalls: [{ id: "1", name: "noop", arguments: "{}", providerData: null }],
          })
        : okResponse();
    });
    const service = new CompletionService({
      transport,
      streamingTransport: transport,
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 90,
      defaultMaxTokens: 8192,
      toolDispatcher: dispatcher,
      toolDefinitions: [{ type: "function", function: { name: "noop" } }],
    });

    await service.run({
      model: "m",
      history: [],
      userText: "hi",
      usageMessages: [],
      temperature: null,
      maxTokens: null,
    });
    expect(dispatched).toBe(true);
  });
});
