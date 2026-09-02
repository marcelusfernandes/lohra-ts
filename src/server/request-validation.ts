/** FastAPI/Pydantic-equivalent 422 body validation for the two POST routes.
 * Mirrors ChatCompletionRequest/ResponsesRequest from lohra/server/app.py —
 * this is a purpose-built validator for those two exact models, not a
 * general JSON-Schema engine: it replicates Pydantic v2's lenient coercions
 * and error shapes for the field/type combinations those two models use. */

export interface ValidationErrorDetail {
  readonly type: string;
  readonly loc: readonly (string | number)[];
  readonly msg: string;
  readonly input: unknown;
  readonly ctx?: Readonly<Record<string, unknown>>;
}

export class ValidationError extends Error {
  public constructor(public readonly details: readonly ValidationErrorDetail[]) {
    super("422 validation error");
  }
}

export function validationErrorBody(
  details: readonly ValidationErrorDetail[],
): Record<string, unknown> {
  return { detail: details };
}

const MISSING_BODY = Symbol("missing-body");

/** Content-Length: 0 is a missing body (Pydantic "Field required" on the
 * whole body), never a JSON-parse failure. A non-JSON Content-Type skips
 * parsing entirely — the raw string is what Pydantic actually receives. */
export function parseRequestBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return MISSING_BODY;
  if (contentType !== undefined && !contentType.toLowerCase().startsWith("application/json"))
    return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ValidationError([
      {
        type: "json_invalid",
        loc: ["body", 1],
        msg: "JSON decode error",
        input: {},
        ctx: { error: error instanceof Error ? error.message : String(error) },
      },
    ]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingError(loc: readonly (string | number)[], input: unknown): ValidationErrorDetail {
  return { type: "missing", loc, msg: "Field required", input };
}

function stringTypeError(loc: readonly (string | number)[], input: unknown): ValidationErrorDetail {
  return { type: "string_type", loc, msg: "Input should be a valid string", input };
}

function listTypeError(loc: readonly (string | number)[], input: unknown): ValidationErrorDetail {
  return { type: "list_type", loc, msg: "Input should be a valid list", input };
}

function dictTypeError(loc: readonly (string | number)[], input: unknown): ValidationErrorDetail {
  return { type: "dict_type", loc, msg: "Input should be a valid dictionary", input };
}

function boolTypeError(loc: readonly (string | number)[], input: unknown): ValidationErrorDetail {
  return { type: "bool_type", loc, msg: "Input should be a valid boolean", input };
}

function boolParsingError(
  loc: readonly (string | number)[],
  input: unknown,
): ValidationErrorDetail {
  return {
    type: "bool_parsing",
    loc,
    msg: "Input should be a valid boolean, unable to interpret input",
    input,
  };
}

function floatParsingError(
  loc: readonly (string | number)[],
  input: unknown,
): ValidationErrorDetail {
  return {
    type: "float_parsing",
    loc,
    msg: "Input should be a valid number, unable to parse string as a number",
    input,
  };
}

const BOOL_TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const BOOL_FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

/** Pydantic v2 lenient bool coercion. `undefined` = could not coerce; caller
 * distinguishes bool_type (fundamentally wrong kind) from bool_parsing
 * (a string/number was attempted and rejected). */
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

/** Pydantic v2 lenient float coercion: numbers pass through, numeric strings
 * parse, everything else fails. */
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
  if (value === MISSING_BODY) throw new ValidationError([missingError(["body"], null)]);
  if (!isPlainObject(value)) {
    throw new ValidationError([
      {
        type: "model_attributes_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary or object to extract fields from",
        input: value,
      },
    ]);
  }

  const errors: ValidationErrorDetail[] = [];
  let model = "";
  if (!("model" in value)) errors.push(missingError(["body", "model"], value));
  else if (typeof value["model"] !== "string")
    errors.push(stringTypeError(["body", "model"], value["model"]));
  else model = value["model"];

  let messages: Readonly<Record<string, unknown>>[] = [];
  if (!("messages" in value)) errors.push(missingError(["body", "messages"], value));
  else if (!Array.isArray(value["messages"]))
    errors.push(listTypeError(["body", "messages"], value["messages"]));
  else {
    const rawMessages = value["messages"];
    const itemErrors: ValidationErrorDetail[] = [];
    rawMessages.forEach((item: unknown, index: number) => {
      if (!isPlainObject(item)) itemErrors.push(dictTypeError(["body", "messages", index], item));
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
          ? boolParsingError(["body", "stream"], value["stream"])
          : boolTypeError(["body", "stream"], value["stream"]),
      );
    } else stream = coerced.value;
  }

  let temperature: number | null = null;
  if ("temperature" in value && value["temperature"] !== null) {
    const coerced = coerceFloat(value["temperature"]);
    if (coerced === undefined)
      errors.push(floatParsingError(["body", "temperature"], value["temperature"]));
    else temperature = coerced;
  }

  let maxTokens: number | null = null;
  if ("max_tokens" in value && value["max_tokens"] !== null) {
    const coerced = coerceInt(value["max_tokens"]);
    if (coerced === undefined)
      errors.push({
        type: "int_parsing",
        loc: ["body", "max_tokens"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: value["max_tokens"],
      });
    else maxTokens = coerced;
  }

  let streamOptions: Record<string, unknown> | null = null;
  if ("stream_options" in value && value["stream_options"] !== null) {
    if (!isPlainObject(value["stream_options"]))
      errors.push(dictTypeError(["body", "stream_options"], value["stream_options"]));
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
  if (value === MISSING_BODY) throw new ValidationError([missingError(["body"], null)]);
  if (!isPlainObject(value)) {
    throw new ValidationError([
      {
        type: "model_attributes_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary or object to extract fields from",
        input: value,
      },
    ]);
  }

  const errors: ValidationErrorDetail[] = [];
  let model = "";
  if (!("model" in value)) errors.push(missingError(["body", "model"], value));
  else if (typeof value["model"] !== "string")
    errors.push(stringTypeError(["body", "model"], value["model"]));
  else model = value["model"];

  let input: string | Readonly<Record<string, unknown>>[] = "";
  if (!("input" in value)) errors.push(missingError(["body", "input"], value));
  else {
    const raw = value["input"];
    if (typeof raw === "string") input = raw;
    else if (Array.isArray(raw)) {
      const itemErrors: ValidationErrorDetail[] = [];
      raw.forEach((item: unknown, index: number) => {
        if (!isPlainObject(item))
          itemErrors.push(dictTypeError(["body", "input", "list[dict[any,any]]", index], item));
      });
      if (itemErrors.length === 0) input = raw as Readonly<Record<string, unknown>>[];
      else errors.push(stringTypeError(["body", "input", "str"], raw), ...itemErrors);
    } else {
      errors.push(
        stringTypeError(["body", "input", "str"], raw),
        listTypeError(["body", "input", "list[dict[any,any]]"], raw),
      );
    }
  }

  let instructions: string | null = null;
  if ("instructions" in value && value["instructions"] !== null) {
    if (typeof value["instructions"] !== "string")
      errors.push(stringTypeError(["body", "instructions"], value["instructions"]));
    else instructions = value["instructions"];
  }

  let stream = false;
  if ("stream" in value) {
    const coerced = coerceBool(value["stream"]);
    if (!coerced.ok) {
      errors.push(
        coerced.parsingAttempted
          ? boolParsingError(["body", "stream"], value["stream"])
          : boolTypeError(["body", "stream"], value["stream"]),
      );
    } else stream = coerced.value;
  }

  let temperature: number | null = null;
  if ("temperature" in value && value["temperature"] !== null) {
    const coerced = coerceFloat(value["temperature"]);
    if (coerced === undefined)
      errors.push(floatParsingError(["body", "temperature"], value["temperature"]));
    else temperature = coerced;
  }

  let maxOutputTokens: number | null = null;
  if ("max_output_tokens" in value && value["max_output_tokens"] !== null) {
    const coerced = coerceInt(value["max_output_tokens"]);
    if (coerced === undefined)
      errors.push({
        type: "int_parsing",
        loc: ["body", "max_output_tokens"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: value["max_output_tokens"],
      });
    else maxOutputTokens = coerced;
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return { model, input, instructions, stream, temperature, maxOutputTokens };
}
