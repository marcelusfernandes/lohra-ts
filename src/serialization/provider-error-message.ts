import { ProviderCallFailed } from "../transports/errors.js";
import { pythonRepr } from "./python-repr.js";

/**
 * Python's repr() for an arbitrary value — not just a string (see
 * python-repr.ts for the string-only, more complete case this delegates to).
 * Used to format a decoded HTTP error payload (typically a small dict) the
 * same way Python's str(APIError) embeds it via %r.
 */
export function pythonReprValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return pythonRepr(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonReprValue).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${pythonReprValue(key)}: ${pythonReprValue(entry)}`)
      .join(", ")}}`;
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return value.name;
  return "None";
}

/**
 * Formats an upstream provider failure the same way the oracle's own SDK
 * str(APIError) does — "Error code: N - {payload!r}" — when the error
 * carries a ProviderCallFailed cause with a status code (a real HTTP
 * failure from the transport layer); falls back to the error's own message
 * otherwise. Shared by the parent's own top-level error surface (chat.ts)
 * and a child's turn failure (child-runner.ts) so the two paths can never
 * silently drift into different wording for the same underlying failure.
 */
export function formatProviderFailureMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ProviderCallFailed && cause.statusCode !== undefined) {
    return `Error code: ${String(cause.statusCode)} - ${pythonReprValue(cause.payload)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
