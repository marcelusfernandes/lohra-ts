/** 422 body validation for the two POST routes (`/v1/chat/completions`,
 * `/v1/responses`). Purpose-built for those two exact request shapes, not a
 * general JSON-Schema engine: it applies the lenient coercions this server
 * has always accepted (numeric strings for `temperature`/`max_tokens`,
 * `"true"`/`0`/`1` for booleans, …) and reports failures in this server's
 * own error envelope — see README "Servidor (`lohra serve`)" and
 * `docs/adr/0003-native-wire-format.md` item 6 (HTTP server). */

export interface ValidationDetail {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly received?: unknown;
}

export class ValidationError extends Error {
  public constructor(public readonly details: readonly ValidationDetail[]) {
    super("422 validation error");
  }
}

/** `["body", "messages", 0, "role"]` -> `"messages[0].role"`; `["body"]`
 * (the whole body) has no param. */
function formatParam(path: readonly (string | number)[]): string | null {
  const segments = path[0] === "body" ? path.slice(1) : path;
  if (segments.length === 0) return null;
  return segments.reduce<string>((out, segment, index) => {
    if (typeof segment === "number") return `${out}[${String(segment)}]`;
    return index === 0 ? segment : `${out}.${segment}`;
  }, "");
}

/** The OpenAI-style error envelope this server emits for every 422: `message`
 * and `param` mirror the first detail found, `details` (an extension beyond
 * the OpenAI shape) carries every failure. */
export function validationErrorBody(details: readonly ValidationDetail[]): Record<string, unknown> {
  const first = details[0];
  const param = first === undefined ? null : formatParam(first.path);
  const message =
    first === undefined
      ? "validation error"
      : param === null
        ? first.message
        : `${param}: ${first.message}`;
  return {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code: "validation_error",
      details,
    },
  };
}

const MISSING_BODY = Symbol("missing-body");

/** Content-Length: 0 is a missing body, never a JSON-parse failure. A
 * non-JSON Content-Type skips parsing entirely — the raw string is handed to
 * the validators below, which reject it as not-a-JSON-object. */
export function parseRequestBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return MISSING_BODY;
  if (contentType !== undefined && !contentType.toLowerCase().startsWith("application/json"))
    return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ValidationError([
      { path: ["body"], message: `request body is not valid JSON: ${cause}` },
    ]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingBodyDetail(): ValidationDetail {
  return { path: ["body"], message: "request body is required" };
}

function missingFieldDetail(path: readonly (string | number)[]): ValidationDetail {
  return { path, message: "field is required" };
}

function typeDetail(
  path: readonly (string | number)[],
  expected: string,
  received: unknown,
): ValidationDetail {
  return { path, message: `expected ${expected}`, received };
}

function parsingDetail(
  path: readonly (string | number)[],
  expected: string,
  received: unknown,
): ValidationDetail {
  return { path, message: `expected ${expected}, could not parse the given value`, received };
}

const BOOL_TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const BOOL_FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

/** Lenient bool coercion this server has always accepted. `undefined` =
 * could not coerce; the caller distinguishes a wrong-kind value from a
 * string/number that was attempted and rejected. */
function coerceBool(
  value: unknown,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly parsingAttempted: boolean } {
  if (typeof value === "boolean") return { ok: true, value };
  if (value === 0 || value === 1) return { ok: true, value: value === 1 };
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (BOOL_TRUE.has(lowered)) return { ok: true, value: true };
    if (BOOL_FALSE.has(lowered)) return { ok: true, value: false };
    return { ok: false, parsingAttempted: true };
  }
  return { ok: false, parsingAttempted: typeof value === "number" };
}

/** Lenient float coercion: numbers pass through, numeric strings parse,
 * everything else fails. */
function coerceFloat(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function coerceInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value);
  return undefined;
}

export interface ParsedChatBody {
  readonly model: string;
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly stream: boolean;
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly streamOptions: Readonly<Record<string, unknown>> | null;
}

export function validateChatBody(value: unknown): ParsedChatBody {
  if (value === MISSING_BODY) throw new ValidationError([missingBodyDetail()]);
  if (!isPlainObject(value)) {
    throw new ValidationError([typeDetail(["body"], "a JSON object", value)]);
  }

  const errors: ValidationDetail[] = [];
  let model = "";
  if (!("model" in value)) errors.push(missingFieldDetail(["body", "model"]));
  else if (typeof value["model"] !== "string")
    errors.push(typeDetail(["body", "model"], "a string", value["model"]));
  else model = value["model"];

  let messages: Readonly<Record<string, unknown>>[] = [];
  if (!("messages" in value)) errors.push(missingFieldDetail(["body", "messages"]));
  else if (!Array.isArray(value["messages"]))
    errors.push(typeDetail(["body", "messages"], "an array", value["messages"]));
  else {
    const rawMessages = value["messages"];
    const itemErrors: ValidationDetail[] = [];
    rawMessages.forEach((item: unknown, index: number) => {
      if (!isPlainObject(item))
        itemErrors.push(typeDetail(["body", "messages", index], "an object", item));
    });
    if (itemErrors.length === 0) messages = rawMessages as Readonly<Record<string, unknown>>[];
    else errors.push(...itemErrors);
  }

  let stream = false;
  if ("stream" in value) {
    const coerced = coerceBool(value["stream"]);
    if (!coerced.ok) {
      errors.push(
        coerced.parsingAttempted
          ? parsingDetail(["body", "stream"], "a boolean", value["stream"])
          : typeDetail(["body", "stream"], "a boolean", value["stream"]),
      );
    } else stream = coerced.value;
  }

  let temperature: number | null = null;
  if ("temperature" in value && value["temperature"] !== null) {
    const coerced = coerceFloat(value["temperature"]);
    if (coerced === undefined)
      errors.push(parsingDetail(["body", "temperature"], "a number", value["temperature"]));
    else temperature = coerced;
  }

  let maxTokens: number | null = null;
  if ("max_tokens" in value && value["max_tokens"] !== null) {
    const coerced = coerceInt(value["max_tokens"]);
    if (coerced === undefined)
      errors.push(parsingDetail(["body", "max_tokens"], "an integer", value["max_tokens"]));
    else maxTokens = coerced;
  }

  let streamOptions: Record<string, unknown> | null = null;
  if ("stream_options" in value && value["stream_options"] !== null) {
    if (!isPlainObject(value["stream_options"]))
      errors.push(typeDetail(["body", "stream_options"], "an object", value["stream_options"]));
    else streamOptions = value["stream_options"];
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return { model, messages, stream, temperature, maxTokens, streamOptions };
}

export interface ParsedResponsesBody {
  readonly model: string;
  readonly input: string | readonly Readonly<Record<string, unknown>>[];
  readonly instructions: string | null;
  readonly stream: boolean;
  readonly temperature: number | null;
  readonly maxOutputTokens: number | null;
}

export function validateResponsesBody(value: unknown): ParsedResponsesBody {
  if (value === MISSING_BODY) throw new ValidationError([missingBodyDetail()]);
  if (!isPlainObject(value)) {
    throw new ValidationError([typeDetail(["body"], "a JSON object", value)]);
  }

  const errors: ValidationDetail[] = [];
  let model = "";
  if (!("model" in value)) errors.push(missingFieldDetail(["body", "model"]));
  else if (typeof value["model"] !== "string")
    errors.push(typeDetail(["body", "model"], "a string", value["model"]));
  else model = value["model"];

  let input: string | Readonly<Record<string, unknown>>[] = "";
  if (!("input" in value)) errors.push(missingFieldDetail(["body", "input"]));
  else {
    const raw = value["input"];
    if (typeof raw === "string") input = raw;
    else if (Array.isArray(raw)) {
      const itemErrors: ValidationDetail[] = [];
      raw.forEach((item: unknown, index: number) => {
        if (!isPlainObject(item))
          itemErrors.push(typeDetail(["body", "input", index], "an object", item));
      });
      if (itemErrors.length === 0) input = raw as Readonly<Record<string, unknown>>[];
      else errors.push(...itemErrors);
    } else {
      errors.push(typeDetail(["body", "input"], "a string or a list of objects", raw));
    }
  }

  let instructions: string | null = null;
  if ("instructions" in value && value["instructions"] !== null) {
    if (typeof value["instructions"] !== "string")
      errors.push(typeDetail(["body", "instructions"], "a string", value["instructions"]));
    else instructions = value["instructions"];
  }

  let stream = false;
  if ("stream" in value) {
    const coerced = coerceBool(value["stream"]);
    if (!coerced.ok) {
      errors.push(
        coerced.parsingAttempted
          ? parsingDetail(["body", "stream"], "a boolean", value["stream"])
          : typeDetail(["body", "stream"], "a boolean", value["stream"]),
      );
    } else stream = coerced.value;
  }

  let temperature: number | null = null;
  if ("temperature" in value && value["temperature"] !== null) {
    const coerced = coerceFloat(value["temperature"]);
    if (coerced === undefined)
      errors.push(parsingDetail(["body", "temperature"], "a number", value["temperature"]));
    else temperature = coerced;
  }

  let maxOutputTokens: number | null = null;
  if ("max_output_tokens" in value && value["max_output_tokens"] !== null) {
    const coerced = coerceInt(value["max_output_tokens"]);
    if (coerced === undefined)
      errors.push(
        parsingDetail(["body", "max_output_tokens"], "an integer", value["max_output_tokens"]),
      );
    else maxOutputTokens = coerced;
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return { model, input, instructions, stream, temperature, maxOutputTokens };
}
