export const MAX_VALIDATION_RETRIES = 2;

export function isEmptyOutput(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

const JSON_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function malformedSchema(schema: Readonly<Record<string, unknown>>, path = "$"): string | null {
  if (schema.type !== undefined && (typeof schema.type !== "string" || !JSON_SCHEMA_TYPES.has(schema.type)))
    return `${path}.type must be a JSON-Schema type`;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  )
    return `${path}.required must be an array of strings`;
  if (
    schema.properties !== undefined &&
    (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties))
  )
    return `${path}.properties must be an object`;
  if (schema.properties !== undefined) {
    for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (child === null || typeof child !== "object" || Array.isArray(child))
        return `${path}.properties.${key} must be an object`;
      const error = malformedSchema(child as Readonly<Record<string, unknown>>, `${path}.properties.${key}`);
      if (error !== null) return error;
    }
  }
  if (schema.items !== undefined) {
    if (schema.items === null || typeof schema.items !== "object" || Array.isArray(schema.items))
      return `${path}.items must be an object`;
    return malformedSchema(schema.items as Readonly<Record<string, unknown>>, `${path}.items`);
  }
  return null;
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

function validateValue(value: unknown, schema: Readonly<Record<string, unknown>>, path = "$"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const typeOk =
    type === undefined ||
    (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number") ||
    (type === "integer" && Number.isInteger(value)) ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "null" && value === null);
  if (!typeOk)
    return [`${path}: expected ${typeof type === "string" ? type : JSON.stringify(type)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value)))
    errors.push(`${path}: not in enum`);
  if (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && !(key in record)) errors.push(`${path}.${key}: required`);
    }
    if (schema.properties !== null && typeof schema.properties === "object") {
      for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (key in record && child !== null && typeof child === "object")
          errors.push(...validateValue(record[key], child as Record<string, unknown>, `${path}.${key}`));
      }
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items !== null && typeof schema.items === "object") {
    value.forEach((item, index) =>
      errors.push(...validateValue(item, schema.items as Record<string, unknown>, `${path}[${String(index)}]`)),
    );
  }
  return errors.slice(0, 3);
}

export function parseAndValidate(
  output: unknown,
  schema: Readonly<Record<string, unknown>>,
): Readonly<{ ok: boolean; value: unknown; error: string }> {
  const schemaError = malformedSchema(schema);
  if (schemaError !== null)
    return Object.freeze({ ok: false, value: null, error: `schema error: ${schemaError}` });
  let value = output;
  if (typeof output === "string") {
    try {
      value = parseLenient(output);
    } catch (error) {
      return Object.freeze({ ok: false, value: null, error: (error as Error).message });
    }
  }
  try {
    const errors = validateValue(value, schema);
    return Object.freeze({ ok: errors.length === 0, value, error: errors.join("; ") });
  } catch (error) {
    return Object.freeze({ ok: false, value: null, error: `schema error: ${(error as Error).message}` });
  }
}

export function correctionPrompt(schema: Readonly<Record<string, unknown>>, error: string): string {
  return `Return valid JSON matching ${JSON.stringify(schema)}. Validation error: ${error}`;
}
