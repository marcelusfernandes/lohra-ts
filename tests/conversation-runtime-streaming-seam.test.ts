import { describe, expect, it } from "vitest";

import { ConversationRuntime, type ConversationRepository, type ModelRequest, type ModelTransport } from "../src/conversation/index.js";
import { ChatCompletionsModel } from "../src/conversation/chat-completions-model.js";
import { AnthropicMessagesModel, ResponsesModel } from "../src/conversation/provider-model.js";
import type {
  AnthropicMessagesClient,
  ChatCompletionsClient,
  NormalizedResponse,
  ResponsesClient,
  StreamCallbacks,
} from "../src/transports/index.js";

// PROVISIONAL, DISPOSABLE (T12 gateway streaming seam). If T11 lands an
// approved equivalent seam first, this whole file and the plumbing it tests
// (runtime.ts's onDelta -> ModelRequest.onText -> adapters' onText ->
// client.stream callbacks) gets dropped wholesale in favor of T11's, not
// merged with it. See the dedicated commit this lands in.

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

function okResponse(): NormalizedResponse {
  return {
    content: "ok",
    finishReason: "stop",
    toolCalls: [],
    reasoning: null,
    usage,
    providerData: null,
  };
}

class MemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<string, { systemPrompt: string; model: string; cwd: string }>();

  createSession(input: { readonly id: string; readonly systemPrompt: string; readonly model: string; readonly cwd: string }): void {
    this.sessions.set(input.id, { systemPrompt: input.systemPrompt, model: input.model, cwd: input.cwd });
  }
  session(id: string) {
    return this.sessions.get(id) ?? null;
  }
  loadMessages() {
    return [];
  }
  commitTurn(): void {}
  commitUsage(): void {}
  summary() {
    return null;
  }
}

// Captures the request without structuredClone -- a real onText function
// value can't survive structuredClone (DataCloneError), so this is
// deliberately not the same QueueTransport used by the pre-existing
// approved conversation-runtime.test.ts.
class CapturingTransport implements ModelTransport {
  public lastRequest: ModelRequest | undefined;

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.lastRequest = request;
    return Promise.resolve(okResponse());
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function runtimeWith(transport: ModelTransport): ConversationRuntime {
  return new ConversationRuntime({
    repository: new MemoryRepository(),
    transport,
    promptSnapshot: () => "prompt",
    idSource: () => "s1",
    clock: () => 1000,
  });
}

describe("ConversationRuntime.runTurn: onDelta -> ModelRequest.onText seam", () => {
  it("onText is ABSENT (not undefined) from the ModelRequest when onDelta is not provided -- zero behavior change", async () => {
    const transport = new CapturingTransport();
    await runtimeWith(transport).runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp" });
    expect(transport.lastRequest).toBeDefined();
    expect("onText" in (transport.lastRequest as ModelRequest)).toBe(false);
  });

  it("threads onDelta through to ModelRequest.onText verbatim when provided", async () => {
    const transport = new CapturingTransport();
    const onDelta = (_text: string): void => {};
    await runtimeWith(transport).runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp", onDelta });
    expect(transport.lastRequest?.onText).toBe(onDelta);
  });
});

describe("ChatCompletionsModel: onText only reaches client.stream() when streaming:true", () => {
  it("streaming:false ignores onText -- calls create(), never stream()", async () => {
    let createCalls = 0;
    let streamCalls = 0;
    const fakeClient = {
      create: () => {
        createCalls += 1;
        return Promise.resolve(okResponse());
      },
      stream: () => {
        streamCalls += 1;
        return Promise.resolve(okResponse());
      },
      close: () => Promise.resolve(),
    } as unknown as ChatCompletionsClient;
    const model = new ChatCompletionsModel(fakeClient, false);
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
      onText: () => {},
    };
    await model.complete(request);
    expect(createCalls).toBe(1);
    expect(streamCalls).toBe(0);
  });

  it("streaming:true passes {onText} through to client.stream()", async () => {
    let receivedCallbacks: StreamCallbacks | undefined;
    const fakeClient = {
      create: () => Promise.resolve(okResponse()),
      stream: (_kwargs: unknown, callbacks: StreamCallbacks) => {
        receivedCallbacks = callbacks;
        return Promise.resolve(okResponse());
      },
      close: () => Promise.resolve(),
    } as unknown as ChatCompletionsClient;
    const model = new ChatCompletionsModel(fakeClient, true);
    const onText = (): void => {};
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
      onText,
    };
    await model.complete(request);
    expect(receivedCallbacks?.onText).toBe(onText);
  });

  it("streaming:true with no onText passes an empty callbacks object, not undefined", async () => {
    let receivedCallbacks: StreamCallbacks | undefined;
    const fakeClient = {
      create: () => Promise.resolve(okResponse()),
      stream: (_kwargs: unknown, callbacks: StreamCallbacks) => {
        receivedCallbacks = callbacks;
        return Promise.resolve(okResponse());
      },
      close: () => Promise.resolve(),
    } as unknown as ChatCompletionsClient;
    const model = new ChatCompletionsModel(fakeClient, true);
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
    };
    await model.complete(request);
    expect(receivedCallbacks).toEqual({});
  });
});

describe("AnthropicMessagesModel: same streaming:boolean gate as ChatCompletionsModel", () => {
  it("streaming:true passes {onText} through to client.stream()", async () => {
    let receivedCallbacks: StreamCallbacks | undefined;
    const fakeClient = {
      create: () => Promise.resolve(okResponse()),
      stream: (_kwargs: unknown, callbacks: StreamCallbacks) => {
        receivedCallbacks = callbacks;
        return Promise.resolve(okResponse());
      },
      close: () => Promise.resolve(),
    } as unknown as AnthropicMessagesClient;
    const model = new AnthropicMessagesModel(fakeClient, true);
    const onText = (): void => {};
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
      onText,
    };
    await model.complete(request);
    expect(receivedCallbacks?.onText).toBe(onText);
  });
});

describe("ResponsesModel: the third, structurally different path", () => {
  it("default (no streaming flag) keeps calling create() unchanged, exactly like before this seam existed", async () => {
    let createCalls = 0;
    const fakeClient = {
      create: () => {
        createCalls += 1;
        return Promise.resolve(okResponse());
      },
      stream: () => Promise.resolve(okResponse()),
      close: () => Promise.resolve(),
    } as unknown as ResponsesClient;
    const model = new ResponsesModel(fakeClient);
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
      onText: () => {},
    };
    await model.complete(request);
    expect(createCalls).toBe(1);
  });

  it("streaming:true reaches stream() directly with onText -- create()'s always-empty-callbacks wrapper is bypassed", async () => {
    let receivedCallbacks: StreamCallbacks | undefined;
    let createCalls = 0;
    const fakeClient = {
      create: () => {
        createCalls += 1;
        return Promise.resolve(okResponse());
      },
      stream: (_kwargs: unknown, callbacks: StreamCallbacks) => {
        receivedCallbacks = callbacks;
        return Promise.resolve(okResponse());
      },
      close: () => Promise.resolve(),
    } as unknown as ResponsesClient;
    const model = new ResponsesModel(fakeClient, true);
    const onText = (): void => {};
    const request: ModelRequest = {
      system: "s",
      messages: [],
      model: "m",
      temperature: null,
      maxTokens: null,
      tools: [],
      signal: new AbortController().signal,
      onText,
    };
    await model.complete(request);
    expect(createCalls).toBe(0);
    expect(receivedCallbacks?.onText).toBe(onText);
  });
});
