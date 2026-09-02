import { StateError } from "./errors.js";

export function safeInteger(value: bigint | number, label: string): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || BigInt(numeric) !== BigInt(value)) {
    throw new StateError("SQLITE_INTEGER_UNSAFE", `${label} is outside the JavaScript safe range`);
  }
  return numeric;
}

export function nullableInteger(value: bigint | number | null, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}
