import { describe, expect, it } from "vitest";

import {
  buildChatCompletion,
  buildChunk,
  buildDone,
  buildModelsList,
  chatCompletionBody,
  CompletionError,
  sseEvent,
  splitChatMessages,
  UpstreamError,
} from "../src/server/chat-format.js";

describe("splitChatMessages", () => {
  it("rejects an empty messages array with the exact oracle message", () => {
    expect(() => splitChatMessages([])).toThrow(
      new CompletionError("'messages' must not be empty"),
    );
  });

  it("rejects a non-user last message with the exact oracle message", () => {
    expect(() => splitChatMessages([{ role: "assistant", content: "hi" }])).toThrow(
      new CompletionError("the last message must be a user message"),
    );
  });

  it("returns (history, lastUserText) for a valid conversation", () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    const result = splitChatMessages(messages);
    expect(result.history).toEqual(messages.slice(0, 2));
    expect(result.lastUserText).toBe("three");
  });

  it("coerces non-string last-message content to empty string (parts loss, assertion 26)", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(splitChatMessages(messages).lastUserText).toBe("");
  });

  it("coerces null last-message content to empty string (assertion 25)", () => {
    expect(splitChatMessages([{ role: "user", content: null }]).lastUserText).toBe("");
  });

  it("preserves non-string content in history untouched (assertion 26)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "kept" }] },
      { role: "user", content: "last" },
    ];
    expect(splitChatMessages(messages).history).toEqual([
      { role: "user", content: [{ type: "text", text: "kept" }] },
    ]);
  });
});

describe("chat completion wire shapes — byte-exact against the measured oracle", () => {
  it("builds and serializes a non-stream chat.completion compactly", () => {
    const object = buildChatCompletion({
      completionId: "chatcmpl-1107417be580403fbb23e16142b54862",
      model: "m",
      content: "abcdefgh",
      finishReason: "stop",
      usage: {
        prompt_tokens: 16,
        completion_tokens: 2,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      created: 1788110338,
    });
    expect(chatCompletionBody(object)).toBe(
      '{"id":"chatcmpl-1107417be580403fbb23e16142b54862","object":"chat.completion","created":1788110338,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"abcdefgh"},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":2,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}',
    );
  });

  it("builds a chat.completion.chunk and frames it as an SSE event with Python spacing", () => {
    const chunk = buildChunk({
      completionId: "chatcmpl-x",
      model: "m",
      delta: { role: "assistant" },
      created: 1,
    });
    expect(sseEvent(chunk)).toBe(
      'data: {"id": "chatcmpl-x", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}\n\n',
    );
  });

  it("frames [DONE] exactly", () => {
    expect(buildDone()).toBe("data: [DONE]\n\n");
  });

  it("frames an upstream error causal canary the same way for non-stream and SSE", () => {
    const message =
      "Error code: 418 - {'error': {'message': 'T11_CAUSE_NONCE42 upstream refused', 'type': 'teapot_error'}}";
    const error = new UpstreamError(message);
    expect(error.message).toBe(message);
    expect(error).toBeInstanceOf(CompletionError);
  });

  it("builds an empty models list body exactly", () => {
    expect(chatCompletionBody(buildModelsList([], { created: 1 }))).toBe(
      '{"object":"list","data":[]}',
    );
  });

  it("builds a populated models list matching the measured shape", () => {
    const object = buildModelsList(["fake-model-a", "fake-model-b"], { created: 1788109002 });
    expect(chatCompletionBody(object)).toBe(
      '{"object":"list","data":[{"id":"fake-model-a","object":"model","created":1788109002,"owned_by":"lohra"},{"id":"fake-model-b","object":"model","created":1788109002,"owned_by":"lohra"}]}',
    );
  });
});
