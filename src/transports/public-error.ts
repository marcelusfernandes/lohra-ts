import { pythonRepr } from "../serialization/python-repr.js";
import { ProviderCallFailed } from "./errors.js";

/** The causal, user-facing message for a failed turn: the SDK-style
 * "Error code: N - {...}" form when the failure carries a ProviderCallFailed
 * cause with a status code, else the error's own message. Shared wherever a
 * failure's cause must reach the user/client (CLI error envelope, T11's
 * upstream 502 / SSE error-frame causal canary). */
export function publicCauseMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ProviderCallFailed && cause.statusCode !== undefined) {
    return `Error code: ${String(cause.statusCode)} - ${pythonRepr(cause.payload)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
