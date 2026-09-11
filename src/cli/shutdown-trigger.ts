// Issue #428: `serve.ts` and `dashboard.ts` each wired their own
// `process.once("SIGINT", handler)` — SIGTERM (what an orchestrator or
// process manager sends first, not SIGINT) had no handler anywhere in this
// codebase. One registration point for both signals, so a future command
// gets the same coverage by construction instead of copying a raw
// `process.once` call and forgetting SIGTERM again.

/** The subset of `process` this module touches — `NodeJS.Process` itself,
 * so a test can inject a fake emitter instead of signaling the real vitest
 * process. */
export interface SignalTarget {
  once(event: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", handler: () => void): unknown;
}

/**
 * Registers `handler` once for SIGTERM and SIGINT, so a command's shutdown
 * path never depends on which of the two arrives — `process.once` per
 * signal, never `process.on`: a second delivery after the first is already
 * being handled falls through to Node's default disposition instead of
 * firing `handler` twice. Returns `unregister`, so a caller that settles
 * through some OTHER path (the server's own `error` event, in `serve.ts`)
 * can remove both listeners without waiting for a signal that may never
 * come.
 */
export function registerShutdownTrigger(
  handler: () => void,
  target: SignalTarget = process,
): () => void {
  target.once("SIGTERM", handler);
  target.once("SIGINT", handler);
  return () => {
    target.off("SIGTERM", handler);
    target.off("SIGINT", handler);
  };
}
