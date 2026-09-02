import { SchemaDefinitionError, validateDraft202012 } from "./json-schema.js";

export const MAX_VALIDATION_RETRIES = 2;

export function isEmptyOutput(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

function parseLenient(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf("{");
    const arrayStart = candidate.indexOf("[");
    const start = Math.min(...[objectStart, arrayStart].filter((value) => value >= 0));
    if (Number.isFinite(start)) {
      for (let end = candidate.length; end > start; end -= 1) {
        try {
          return JSON.parse(candidate.slice(start, end));
        } catch {
          // Continue shrinking a prose suffix.
        }
      }
    }
    throw new Error("the answer is not valid JSON");
  }
}

export function parseAndValidate(
  output: unknown,
  schema: Readonly<Record<string, unknown>>,
): Readonly<{ ok: boolean; value: unknown; error: string }> {
  let value = output;
  if (typeof output === "string") {
    try {
      value = parseLenient(output);
    } catch (error) {
      return Object.freeze({ ok: false, value: null, error: (error as Error).message });
    }
  }
  try {
    const errors = validateDraft202012(value, schema);
    return Object.freeze({ ok: errors.length === 0, value, error: errors.join("; ") });
  } catch (error) {
    const message =
      error instanceof SchemaDefinitionError ? error.message : (error as Error).message;
    return Object.freeze({ ok: false, value: null, error: `schema error: ${message}` });
  }
}

export function correctionPrompt(schema: Readonly<Record<string, unknown>>, error: string): string {
  return `Return valid JSON matching ${JSON.stringify(schema)}. Validation error: ${error}`;
}
