// Issue #428: `serve.ts` and `dashboard.ts` each wired their own
// `process.once("SIGINT", handler)` — SIGTERM had no handler anywhere in
// this codebase. Stub only — `tests/workflow-shutdown-signal.test.ts`
// exercises this module before the real implementation lands.

export interface SignalTarget {
  once(event: "SIGTERM" | "SIGINT", handler: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", handler: () => void): unknown;
}

export function registerShutdownTrigger(
  _handler: () => void,
  _target: SignalTarget = process,
): () => void {
  throw new Error("not implemented: registerShutdownTrigger");
}
