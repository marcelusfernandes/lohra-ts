import { describe, expect, it } from "vitest";

import {
  parseRequestBody,
  validateChatBody,
  validateResponsesBody,
  ValidationError,
  validationErrorBody,
} from "../src/server/request-validation.js";
import { chatCompletionBody } from "../src/server/chat-format.js";

/** Round-trips through the real wire serializer and back to a loose value —
 * asserts on the envelope's data shape, never on the internal detail type,
 * so this test only ever fails on behavior, never on a field rename. */
function detailEnvelope(raw: string, contentType: string | undefined): unknown {
  try {
    const value = parseRequestBody(raw, contentType);
    validateChatBody(value);
    throw new Error("expected ValidationError");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return JSON.parse(chatCompletionBody(validationErrorBody(error.details)));
  }
}

function responsesEnvelope(raw: string): unknown {
  try {
    const value = parseRequestBody(raw, "application/json");
    validateResponsesBody(value);
    throw new Error("expected ValidationError");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return JSON.parse(chatCompletionBody(validationErrorBody(error.details)));
  }
}

describe("validationErrorBody — own OpenAI-style envelope (issue #74)", () => {
  it("body vazio: a zero-length body is a missing body, not invalid JSON", () => {
    expect(detailEnvelope("", "application/json")).toEqual({
      error: {
        message: "request body is required",
        type: "invalid_request_error",
        param: null,
        code: "validation_error",
        details: [{ path: ["body"], message: "request body is required" }],
      },
    });
  });

  it("JSON malformed: message names the field and embeds the parse cause", () => {
    const body = detailEnvelope("{nope", "application/json") as {
      error: { message: string; param: string | null; details: { message: string }[] };
    };
    expect(body.error.param).toBeNull();
    expect(body.error.message).toMatch(/^request body is not valid JSON: .+/u);
    expect(body.error.details).toHaveLength(1);
    expect(body.error.details[0]?.message).toBe(body.error.message);
  });

  it("Content-Type text/plain: the whole body is a raw string, not an object", () => {
    const raw =
      '{"model": "fake-model-a", "messages": [{"role": "user", "content": "SCEN:ok hi"}]}';
    expect(detailEnvelope(raw, "text/plain")).toEqual({
      error: {
        message: "expected a JSON object",
        type: "invalid_request_error",
        param: null,
        code: "validation_error",
        details: [{ path: ["body"], message: "expected a JSON object", received: raw }],
      },
    });
  });

  it("model ausente: campo obrigatório, sem 'received' (não há o que ecoar)", () => {
    expect(
      detailEnvelope('{"messages": [{"role": "user", "content": "x"}]}', "application/json"),
    ).toEqual({
      error: {
        message: "model: field is required",
        type: "invalid_request_error",
        param: "model",
        code: "validation_error",
        details: [{ path: ["body", "model"], message: "field is required" }],
      },
    });
  });

  it("messages não-lista: tipo errado, com 'received' e path indexado", () => {
    expect(detailEnvelope('{"model": "m", "messages": "x"}', "application/json")).toEqual({
      error: {
        message: "messages: expected an array",
        type: "invalid_request_error",
        param: "messages",
        code: "validation_error",
        details: [{ path: ["body", "messages"], message: "expected an array", received: "x" }],
      },
    });
  });

  it("item de messages não-dict: path aponta para o índice do array (assertion de enum-adjacent shape)", () => {
    expect(detailEnvelope('{"model": "m", "messages": ["x"]}', "application/json")).toEqual({
      error: {
        message: "messages[0]: expected an object",
        type: "invalid_request_error",
        param: "messages[0]",
        code: "validation_error",
        details: [{ path: ["body", "messages", 0], message: "expected an object", received: "x" }],
      },
    });
  });

  it('temperature:"hot": valor não coercível é reportado como parsing failure', () => {
    expect(
      detailEnvelope(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "temperature": "hot"}',
        "application/json",
      ),
    ).toEqual({
      error: {
        message: "temperature: expected a number, could not parse the given value",
        type: "invalid_request_error",
        param: "temperature",
        code: "validation_error",
        details: [
          {
            path: ["body", "temperature"],
            message: "expected a number, could not parse the given value",
            received: "hot",
          },
        ],
      },
    });
  });

  it("stream:null: tipo fundamentalmente errado (não uma tentativa de parse)", () => {
    expect(
      detailEnvelope(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": null}',
        "application/json",
      ),
    ).toEqual({
      error: {
        message: "stream: expected a boolean",
        type: "invalid_request_error",
        param: "stream",
        code: "validation_error",
        details: [{ path: ["body", "stream"], message: "expected a boolean", received: null }],
      },
    });
  });

  it('stream:"maybe": string que tentou e falhou a coerção -- parsing, não type', () => {
    expect(
      detailEnvelope(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": "maybe"}',
        "application/json",
      ),
    ).toEqual({
      error: {
        message: "stream: expected a boolean, could not parse the given value",
        type: "invalid_request_error",
        param: "stream",
        code: "validation_error",
        details: [
          {
            path: ["body", "stream"],
            message: "expected a boolean, could not parse the given value",
            received: "maybe",
          },
        ],
      },
    });
  });

  it("stream_options não-dict: tipo errado", () => {
    expect(
      detailEnvelope(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream_options": "x"}',
        "application/json",
      ),
    ).toEqual({
      error: {
        message: "stream_options: expected an object",
        type: "invalid_request_error",
        param: "stream_options",
        code: "validation_error",
        details: [
          { path: ["body", "stream_options"], message: "expected an object", received: "x" },
        ],
      },
    });
  });

  it('max_tokens:"nope": integer parsing failure', () => {
    expect(
      detailEnvelope(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "max_tokens": "nope"}',
        "application/json",
      ),
    ).toEqual({
      error: {
        message: "max_tokens: expected an integer, could not parse the given value",
        type: "invalid_request_error",
        param: "max_tokens",
        code: "validation_error",
        details: [
          {
            path: ["body", "max_tokens"],
            message: "expected an integer, could not parse the given value",
            received: "nope",
          },
        ],
      },
    });
  });

  it("multiple errors: message/param reflect the first, details carries every failure", () => {
    const body = detailEnvelope('{"messages": "x", "stream": null}', "application/json") as {
      error: { message: string; param: string | null; details: { path: unknown[] }[] };
    };
    expect(body.error.param).toBe("model");
    expect(body.error.message).toBe("model: field is required");
    expect(body.error.details).toHaveLength(3);
    expect(body.error.details.map((detail) => detail.path)).toEqual([
      ["body", "model"],
      ["body", "messages"],
      ["body", "stream"],
    ]);
  });

  it('coerces stream:"true" and a numeric temperature string (assertion 27, lenient parsing kept)', () => {
    const value = parseRequestBody(
      '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": "true", "temperature": "0.5"}',
      "application/json",
    );
    const parsed = validateChatBody(value);
    expect(parsed.stream).toBe(true);
    expect(parsed.temperature).toBe(0.5);
  });

  it("[probe-complementar] client tools/tool_choice are structurally impossible to reach the parsed body (assertion 51)", () => {
    const value = parseRequestBody(
      JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "evil" } }],
        tool_choice: "evil",
      }),
      "application/json",
    );
    const parsed = validateChatBody(value);
    expect(Object.keys(parsed)).not.toContain("tools");
    expect(Object.keys(parsed)).not.toContain("toolChoice");
    expect(Object.keys(parsed).sort()).toEqual(
      ["maxTokens", "messages", "model", "stream", "streamOptions", "temperature"].sort(),
    );
  });

  it("extra unknown fields are ignored without error (assertion 25) -- not rejected, so no 422 case for them", () => {
    const value = parseRequestBody(
      '{"model": "", "messages": [{"role": "user", "content": null}], "top_p": 1, "n": 2, "tools": [{}], "tool_choice": "auto"}',
      "application/json",
    );
    const parsed = validateChatBody(value);
    expect(parsed.model).toBe("");
    expect(parsed.messages).toEqual([{ role: "user", content: null }]);
  });
});

describe("validateResponsesBody — union input field, own envelope", () => {
  it("model ausente for Responses", () => {
    expect(responsesEnvelope('{"input": "x"}')).toEqual({
      error: {
        message: "model: field is required",
        type: "invalid_request_error",
        param: "model",
        code: "validation_error",
        details: [{ path: ["body", "model"], message: "field is required" }],
      },
    });
  });

  it("input numérico: neither a string nor a list -- one detail, not a leaked union-branch pair", () => {
    expect(responsesEnvelope('{"model": "m", "input": 5}')).toEqual({
      error: {
        message: "input: expected a string or a list of objects",
        type: "invalid_request_error",
        param: "input",
        code: "validation_error",
        details: [
          {
            path: ["body", "input"],
            message: "expected a string or a list of objects",
            received: 5,
          },
        ],
      },
    });
  });

  it('input:["x"]: the array shape is fine, only the bad item is reported', () => {
    expect(responsesEnvelope('{"model": "m", "input": ["x"]}')).toEqual({
      error: {
        message: "input[0]: expected an object",
        type: "invalid_request_error",
        param: "input[0]",
        code: "validation_error",
        details: [{ path: ["body", "input", 0], message: "expected an object", received: "x" }],
      },
    });
  });

  it("[probe-complementar] Responses has no tools/tool_choice field to begin with (assertion 51)", () => {
    const parsed = validateResponsesBody(
      parseRequestBody(
        '{"model": "m", "input": "hi", "tools": [{"evil": true}]}',
        "application/json",
      ),
    );
    expect(Object.keys(parsed).sort()).toEqual(
      ["input", "instructions", "maxOutputTokens", "model", "stream", "temperature"].sort(),
    );
  });

  it("a valid string input or a valid list-of-dicts input produces zero 422 errors", () => {
    expect(() =>
      validateResponsesBody(parseRequestBody('{"model": "m", "input": "hi"}', "application/json")),
    ).not.toThrow();
    expect(() =>
      validateResponsesBody(
        parseRequestBody(
          '{"model": "m", "input": [{"role": "user", "content": "hi"}]}',
          "application/json",
        ),
      ),
    ).not.toThrow();
  });
});
