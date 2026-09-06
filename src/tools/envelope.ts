import { stringifyJsonPreservingNumbers } from "../serialization/json-numbers.js";

export function toolError(message: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return stringifyJsonPreservingNumbers({ error: message, ...extra });
}

export function toolResult(data?: unknown, extra: Readonly<Record<string, unknown>> = {}): string {
  const payload: Record<string, unknown> = { ok: true };
  if (data !== undefined && data !== null) payload.data = data;
  return stringifyJsonPreservingNumbers({ ...payload, ...extra });
}
