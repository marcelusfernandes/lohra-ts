// Issue #428: `serve.ts` and `dashboard.ts` each wired their own
// `process.once("SIGINT", handler)` — SIGTERM (what an orchestrator or
// process manager sends first, not SIGINT) had no handler anywhere in this
// codebase. One registration point for both signals, so a future command
// gets the same coverage by construction instead of copying a raw
// `process.once` call and forgetting SIGTERM again.
//
// Issue #434: neither signal's `process.once` disarmed the OTHER one, so a
// SECOND delivery — of the SAME signal OR the other one — still fired
// `handler` again (SIGTERM then SIGINT re-entered whatever `handler` does).
// The handler this module actually registers now unregisters BOTH signals
// before invoking the caller's `handler`, so exactly one delivery — of
// either kind — fires it per registration.

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
 * signal, never `process.on`. That alone only guards a SECOND delivery of
 * the SAME signal (Node's own `once` semantics); the wrapped handler below
 * additionally disarms the OTHER signal on its first delivery — `unregister`
 * runs before `handler` itself is invoked — so SIGTERM immediately followed
 * by SIGINT (an orchestrator or process manager sending both) still fires
 * `handler` exactly once per registration, never twice. Returns that same
 * `unregister`, so a caller that settles through some OTHER path (the
 * server's own `error` event, in `serve.ts`) can remove both listeners
 * without waiting for a signal that may never come.
 */
export function registerShutdownTrigger(
  handler: () => void,
  target: SignalTarget = process,
): () => void {
  function unregister(): void {
    target.off("SIGTERM", wrapped);
    target.off("SIGINT", wrapped);
  }
  function wrapped(): void {
    unregister();
    handler();
  }
  target.once("SIGTERM", wrapped);
  target.once("SIGINT", wrapped);
  return unregister;
}
