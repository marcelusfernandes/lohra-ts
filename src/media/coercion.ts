import { MAX_IMAGES } from "./constants.js";

/**
 * Presence and integer-coercion rules for media tool arguments — a local
 * decision, distinct from the shared JSON presence rule in
 * `src/serialization/json-presence.ts` (`isEmptyJsonValue`/`hasJsonValue`).
 *
 * `isPresentMediaValue` truth table (absent → `false`):
 *
 * | value                                | present? |
 * | ------------------------------------- | -------- |
 * | `undefined`, `null`, `false`          | false    |
 * | `NaN`                                 | false    |
 * | `0`, `0n`                             | false    |
 * | any other finite number, other bigint | true     |
 * | `""`, `[]`                            | false    |
 * | any other string or array             | true     |
 * | `{}`                                  | false    |
 * | any other object                      | true     |
 * | anything else (function, symbol, …)   | true     |
 *
 * It differs from `json-presence.ts` on the two rows that matter for media
 * tool arguments read straight off untyped JSON: `NaN` reads as absent here
 * (json-presence never special-cases `NaN`, so it reads as present there),
 * and `bigint` is understood at all — including `0n` as absent — where
 * json-presence has no `bigint` branch and treats every bigint as present.
 * A caller that hands over `NaN` or `0n` for an image argument should not
 * silently get "present" back.
 */
export function isPresentMediaValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function coerceImagePrompt(value: unknown): string {
  if (!isPresentMediaValue(value)) throw new Error("image_gen requires a non-empty 'prompt'");
  const prompt = typeof value === "string" ? value : JSON.stringify(value);
  if (prompt.trim().length === 0) throw new Error("image_gen requires a non-empty 'prompt'");
  return prompt;
}

/**
 * Strict integer coercion for media tool arguments: booleans map to `0`/`1`,
 * finite numbers truncate toward zero, and a string only parses when it is a
 * plain optional-sign integer literal (no decimals, no exponents, no
 * leading/trailing junk) that also fits `Number.isSafeInteger`. Everything
 * else — `NaN`, `Infinity`, non-numeric strings, objects — is `undefined`.
 */
export function coerceInt(value: unknown): number | undefined {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function coerceImageCount(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const parsed = coerceInt(value);
  if (parsed === undefined || parsed < 1) return 1;
  return Math.min(parsed, MAX_IMAGES);
}

export function coerceImageSize(value: unknown): unknown {
  return isPresentMediaValue(value) ? value : undefined;
}

export function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
