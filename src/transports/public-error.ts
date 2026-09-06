import { ProviderCallFailed } from "./errors.js";

/** The causal, user-facing message for a failed turn: the SDK-style
 * "Error code: N - {...}" form when the failure carries a ProviderCallFailed
 * cause with a status code, else the error's own message. Shared wherever a
 * failure's cause must reach the user/client (CLI error envelope, T11's
 * upstream 502 / SSE error-frame causal canary). The payload is cited as
 * JSON (ADR 0003 item 5); a payload of `undefined` is cited as the literal
 * `undefined`, never a Python placeholder. */
export function publicCauseMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ProviderCallFailed && cause.statusCode !== undefined) {
    const cited = cause.payload === undefined ? "undefined" : JSON.stringify(cause.payload);
    return `Error code: ${String(cause.statusCode)} - ${cited}`;
  }
  return error instanceof Error ? error.message : String(error);
}
