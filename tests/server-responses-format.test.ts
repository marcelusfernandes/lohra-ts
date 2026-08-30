import { describe, expect, it } from "vitest";

import { CompletionError } from "../src/server/chat-format.js";
import {
  buildContentPartAddedEvent,
  buildOutputItemAddedEvent,
  buildResponseCompletedEvent,
  buildResponseCreatedEvent,
  buildResponseFailedEvent,
  buildResponseObject,
  buildTextDeltaEvent,
  parseResponsesInput,
} from "../src/server/responses-format.js";

describe("parseResponsesInput", () => {
  it("rejects an empty string input with the exact oracle message", () => {
    expect(() => parseResponsesInput("", null)).toThrow(
      new CompletionError("'input' must not be empty"),
    );
  });

  it("rejects an empty list input with the exact oracle message", () => {
    expect(() => parseResponsesInput([], null)).toThrow(
      new CompletionError("'input' must not be empty"),
    );
  });

  it("rejects an input item without a role", () => {
    expect(() => parseResponsesInput([{ content: "x" }], null)).toThrow(
      new CompletionError("each input item needs a 'role' and 'content'"),
    );
  });

  it("prepends instructions as a system message when truthy", () => {
    expect(parseResponsesInput("hi", "be nice")).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ]);
  });

  it("omits the system message when instructions is null or empty", () => {
    expect(parseResponsesInput("hi", null)).toEqual([{ role: "user", content: "hi" }]);
    expect(parseResponsesInput("hi", "")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("concatenates text/input_text/output_text parts and drops other part types", () => {
    const parsed = parseResponsesInput(
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "a" },
            { type: "image_url", url: "ignored" },
            { type: "text", text: "b" },
          ],
        },
      ],
      null,
    );
    expect(parsed).toEqual([{ role: "user", content: "ab" }]);
  });

  it("matches the measured B5/L14 vector: a single input_text part concatenates to 17 chars", () => {
    const parsed = parseResponsesInput(
      [{ role: "user", content: [{ type: "input_text", text: "SCEN:nousage abcd" }] }],
      null,
    );
    expect(parsed).toEqual([{ role: "user", content: "SCEN:nousage abcd" }]);
    expect((parsed[0] as { content: string }).content.length).toBe(17);
  });
});

describe("Responses non-stream object", () => {
  it("matches the 16-field measured shape and remaps usage to input_tokens/output_tokens", () => {
    const object = buildResponseObject({
      responseId: "resp_3df923e01c8b4d1f894a6dd9cb9ac25c",
      model: "m",
      content: "Hello wire",
      status: "completed",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
      created: 1788110338,
    });
    expect(object).toEqual({
      id: "resp_3df923e01c8b4d1f894a6dd9cb9ac25c",
      object: "response",
      created_at: 1788110338,
      status: "completed",
      model: "m",
      output: [
        {
          type: "message",
          id: "msg_resp_3df923e01c8b4d1f894a6dd9cb9ac25c",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello wire", annotations: [] }],
        },
      ],
      output_text: "Hello wire",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      parallel_tool_calls: false,
      tool_choice: "auto",
      tools: [],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 107,
      },
    });
  });

  it("emits output:[] when content is empty and status is not completed", () => {
    const object = buildResponseObject({
      responseId: "resp_x",
      model: "m",
      content: "",
      status: "failed",
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      created: 1,
      error: { code: "server_error", message: "boom" },
    });
    expect(object["output"]).toEqual([]);
    expect(object["error"]).toEqual({ code: "server_error", message: "boom" });
  });
});

describe("Responses SSE event sequence — byte-exact against the measured oracle", () => {
  it("matches the measured response.created frame", () => {
    expect(
      buildResponseCreatedEvent({
        responseId: "resp_5cbb027aa4f1437f82e6deac6bb87f5b",
        model: "m",
        created: 1788115771,
        sequenceNumber: 0,
      }),
    ).toBe(
      'event: response.created\ndata: {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_5cbb027aa4f1437f82e6deac6bb87f5b", "object": "response", "created_at": 1788115771, "status": "in_progress", "model": "m", "output": [], "error": null, "incomplete_details": null, "instructions": null, "metadata": {}, "parallel_tool_calls": false, "tool_choice": "auto", "tools": []}}\n\n',
    );
  });

  it("matches the measured response.output_item.added frame", () => {
    expect(
      buildOutputItemAddedEvent({
        responseId: "resp_5cbb027aa4f1437f82e6deac6bb87f5b",
        sequenceNumber: 1,
      }),
    ).toBe(
      'event: response.output_item.added\ndata: {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0, "item": {"type": "message", "id": "msg_resp_5cbb027aa4f1437f82e6deac6bb87f5b", "status": "in_progress", "role": "assistant", "content": []}}\n\n',
    );
  });

  it("matches the measured response.content_part.added frame", () => {
    expect(
      buildContentPartAddedEvent({
        responseId: "resp_5cbb027aa4f1437f82e6deac6bb87f5b",
        sequenceNumber: 2,
      }),
    ).toBe(
      'event: response.content_part.added\ndata: {"type": "response.content_part.added", "sequence_number": 2, "item_id": "msg_resp_5cbb027aa4f1437f82e6deac6bb87f5b", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}\n\n',
    );
  });

  it("matches the measured response.output_text.delta frame", () => {
    expect(
      buildTextDeltaEvent({
        responseId: "resp_b9ebecef30a847149d136eff274b907b",
        delta: "par",
        sequenceNumber: 3,
      }),
    ).toBe(
      'event: response.output_text.delta\ndata: {"type": "response.output_text.delta", "sequence_number": 3, "item_id": "msg_resp_b9ebecef30a847149d136eff274b907b", "output_index": 0, "content_index": 0, "delta": "par", "logprobs": []}\n\n',
    );
  });

  it("frames response.completed and response.failed with the response object nested under 'response'", () => {
    const object = buildResponseObject({
      responseId: "resp_x",
      model: "m",
      content: "hi",
      status: "completed",
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      created: 1,
    });
    const completed = buildResponseCompletedEvent(object, { sequenceNumber: 5 });
    expect(completed.startsWith("event: response.completed\ndata: ")).toBe(true);
    expect(completed).toContain('"type": "response.completed"');
    expect(completed).toContain('"sequence_number": 5');
    expect(completed.endsWith("\n\n")).toBe(true);

    const failed = buildResponseFailedEvent(object, { sequenceNumber: 6 });
    expect(failed.startsWith("event: response.failed\ndata: ")).toBe(true);
  });
});
