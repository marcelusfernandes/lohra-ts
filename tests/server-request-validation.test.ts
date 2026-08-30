import { describe, expect, it } from "vitest";

import {
  parseRequestBody,
  validateChatBody,
  validateResponsesBody,
  ValidationError,
  validationErrorBody,
} from "../src/server/request-validation.js";
import { chatCompletionBody } from "../src/server/chat-format.js";

function detailBody(raw: string, contentType: string | undefined): string {
  try {
    const value = parseRequestBody(raw, contentType);
    validateChatBody(value);
    throw new Error("expected ValidationError");
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return chatCompletionBody(validationErrorBody(error.details));
  }
}

describe("parseRequestBody + validateChatBody — byte-exact against measured oracle 422 bodies", () => {
  it("model ausente: input echoes the submitted body", () => {
    expect(detailBody('{"messages": [{"role": "user", "content": "x"}]}', "application/json")).toBe(
      '{"detail":[{"type":"missing","loc":["body","model"],"msg":"Field required","input":{"messages":[{"role":"user","content":"x"}]}}]}',
    );
  });

  it("body vazio: a zero-length body is a missing body, not invalid JSON", () => {
    expect(detailBody("", "application/json")).toBe(
      '{"detail":[{"type":"missing","loc":["body"],"msg":"Field required","input":null}]}',
    );
  });

  it("Content-Type text/plain: the whole body is a raw string, not a dict", () => {
    const raw = '{"model": "fake-model-a", "messages": [{"role": "user", "content": "SCEN:ok hi"}]}';
    expect(detailBody(raw, "text/plain")).toBe(
      chatCompletionBody({
        detail: [
          {
            type: "model_attributes_type",
            loc: ["body"],
            msg: "Input should be a valid dictionary or object to extract fields from",
            input: raw,
          },
        ],
      }),
    );
  });

  it("messages não-lista", () => {
    expect(detailBody('{"model": "m", "messages": "x"}', "application/json")).toBe(
      '{"detail":[{"type":"list_type","loc":["body","messages"],"msg":"Input should be a valid list","input":"x"}]}',
    );
  });

  it("item de messages não-dict", () => {
    expect(detailBody('{"model": "m", "messages": ["x"]}', "application/json")).toBe(
      '{"detail":[{"type":"dict_type","loc":["body","messages",0],"msg":"Input should be a valid dictionary","input":"x"}]}',
    );
  });

  it("temperature:\"hot\"", () => {
    expect(
      detailBody(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "temperature": "hot"}',
        "application/json",
      ),
    ).toBe(
      '{"detail":[{"type":"float_parsing","loc":["body","temperature"],"msg":"Input should be a valid number, unable to parse string as a number","input":"hot"}]}',
    );
  });

  it("stream:null", () => {
    expect(
      detailBody(
        '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": null}',
        "application/json",
      ),
    ).toBe('{"detail":[{"type":"bool_type","loc":["body","stream"],"msg":"Input should be a valid boolean","input":null}]}');
  });

  it("JSON malformed: json_invalid with excused offset/ctx.error, everything else exact", () => {
    let caught: ValidationError | undefined;
    try {
      parseRequestBody("{nope", "application/json");
    } catch (error) {
      if (error instanceof ValidationError) caught = error;
    }
    expect(caught).toBeDefined();
    const detail = caught?.details[0];
    expect(detail?.type).toBe("json_invalid");
    expect(detail?.loc[0]).toBe("body");
    expect(typeof detail?.loc[1]).toBe("number");
    expect(detail?.msg).toBe("JSON decode error");
    expect(detail?.input).toEqual({});
    expect(typeof detail?.ctx?.["error"]).toBe("string");
  });

  it("coerces stream:\"true\" and a numeric temperature string (assertion 27, lenient Pydantic parsing)", () => {
    const value = parseRequestBody(
      '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": "true", "temperature": "0.5"}',
      "application/json",
    );
    const parsed = validateChatBody(value);
    expect(parsed.stream).toBe(true);
    expect(parsed.temperature).toBe(0.5);
  });

  it("extra unknown fields are ignored without error (assertion 25)", () => {
    const value = parseRequestBody(
      '{"model": "", "messages": [{"role": "user", "content": null}], "top_p": 1, "n": 2, "tools": [{}], "tool_choice": "auto"}',
      "application/json",
    );
    const parsed = validateChatBody(value);
    expect(parsed.model).toBe("");
    expect(parsed.messages).toEqual([{ role: "user", content: null }]);
  });
});

describe("validateResponsesBody — union input field, byte-exact", () => {
  it("model ausente for Responses", () => {
    const value = parseRequestBody('{"input": "x"}', "application/json");
    let caught: ValidationError | undefined;
    try {
      validateResponsesBody(value);
    } catch (error) {
      if (error instanceof ValidationError) caught = error;
    }
    expect(caught?.details).toEqual([
      { type: "missing", loc: ["body", "model"], msg: "Field required", input: { input: "x" } },
    ]);
  });

  it("input numérico: two union-branch errors in order (string then list[dict])", () => {
    const value = parseRequestBody('{"model": "m", "input": 5}', "application/json");
    let caught: ValidationError | undefined;
    try {
      validateResponsesBody(value);
    } catch (error) {
      if (error instanceof ValidationError) caught = error;
    }
    expect(caught?.details).toEqual([
      { type: "string_type", loc: ["body", "input", "str"], msg: "Input should be a valid string", input: 5 },
      {
        type: "list_type",
        loc: ["body", "input", "list[dict[any,any]]"],
        msg: "Input should be a valid list",
        input: 5,
      },
    ]);
  });

  it("input:[\"x\"]: string branch fails on the whole array, list branch fails on the item", () => {
    const value = parseRequestBody('{"model": "m", "input": ["x"]}', "application/json");
    let caught: ValidationError | undefined;
    try {
      validateResponsesBody(value);
    } catch (error) {
      if (error instanceof ValidationError) caught = error;
    }
    expect(caught?.details).toEqual([
      {
        type: "string_type",
        loc: ["body", "input", "str"],
        msg: "Input should be a valid string",
        input: ["x"],
      },
      {
        type: "dict_type",
        loc: ["body", "input", "list[dict[any,any]]", 0],
        msg: "Input should be a valid dictionary",
        input: "x",
      },
    ]);
  });

  it("a valid string input or a valid list-of-dicts input produces zero 422 errors", () => {
    expect(() =>
      validateResponsesBody(parseRequestBody('{"model": "m", "input": "hi"}', "application/json")),
    ).not.toThrow();
    expect(() =>
      validateResponsesBody(
        parseRequestBody('{"model": "m", "input": [{"role": "user", "content": "hi"}]}', "application/json"),
      ),
    ).not.toThrow();
  });
});
