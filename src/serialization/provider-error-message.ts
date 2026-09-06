import { ProviderCallFailed } from "../transports/errors.js";

/**
 * Formats an upstream provider failure the same way the SDK-style causal
 * canary does — "Error code: N - {payload}" — when the error carries a
 * ProviderCallFailed cause with a status code (a real HTTP failure from the
 * transport layer); falls back to the error's own message otherwise. Shared
 * by the parent's own top-level error surface (chat.ts) and a child's turn
 * failure (child-runner.ts) so the two paths can never silently drift into
 * different wording for the same underlying failure. The payload is cited
 * as JSON (ADR 0003 item 5); a payload of `undefined` is cited as the
 * literal `undefined`, never a Python placeholder.
 */
export function formatProviderFailureMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof ProviderCallFailed && cause.statusCode !== undefined) {
    const cited = cause.payload === undefined ? "undefined" : JSON.stringify(cause.payload);
    return `Error code: ${String(cause.statusCode)} - ${cited}`;
  }
  return error instanceof Error ? error.message : String(error);
}
