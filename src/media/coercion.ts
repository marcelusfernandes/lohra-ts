import { MAX_IMAGES } from "./constants.js";

// TODO(#94, test-red): renomes reais chegam no commit seguinte.
export function isPresentMediaValue(_value: unknown): boolean {
  throw new Error("not implemented");
}

export function coerceInt(_value: unknown): number | undefined {
  throw new Error("not implemented");
}

export function pythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function coerceImagePrompt(value: unknown): string {
  if (!pythonTruthy(value)) throw new Error("image_gen requires a non-empty 'prompt'");
  const prompt = typeof value === "string" ? value : JSON.stringify(value);
  if (prompt.trim().length === 0) throw new Error("image_gen requires a non-empty 'prompt'");
  return prompt;
}

function pythonInt(value: unknown): number | undefined {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function coerceImageCount(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const parsed = pythonInt(value);
  if (parsed === undefined || parsed < 1) return 1;
  return Math.min(parsed, MAX_IMAGES);
}

export function coerceImageSize(value: unknown): unknown {
  return pythonTruthy(value) ? value : undefined;
}

export function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
