// Issue #302: `await sleep(50)` used to be how a handful of dashboard tests
// waited for `runDashboard` to finish binding before reading `stderrLines`.
// That races the real boot work between argv parsing and the bind
// (credential resolution, SQLite open, MCP registration -- dashboard.ts's
// own `runDashboard` body) whenever the event loop is busy with other test
// files: reproduced with two full `npm test` runs at once (2/5 rounds),
// `AssertionError: expected false to be true` in `tests/dashboard-host.test.ts`
// at "does NOT refuse --insecure with an explicit loopback --host
// (localhost)" -- the banner had not reached `stderrLines` yet 50ms in.
// Never reproduced in 10 sequential full-suite runs nor 15-30 isolated
// reruns of that file alone, consistent with a starved-event-loop race
// rather than port or IPv6 state. `registerShutdownTrigger` is only invoked
// (dashboard.ts, right after the real bind and banner print) once boot has
// actually finished, so it doubles as a ready signal: awaiting it removes
// the wall-clock race instead of guessing a longer delay.
//
// Issue #307 applied the same fix to the five leftover `setTimeout(50)` in
// `tests/gateway/dashboard-command.test.ts`, duplicating this function
// verbatim into both files. Issue #311 extracts the single copy here so a
// future fix never has to choose which duplicate to edit.
export interface WaitUntilBoundOptions {
  registerShutdownTrigger?: (handler: () => void) => void;
}

export interface WaitUntilBoundResult {
  readonly ready: Promise<void>;
  readonly shutdown: () => void;
}

export function waitUntilBound(options: WaitUntilBoundOptions): WaitUntilBoundResult {
  let handler: (() => void) | undefined;
  const ready = new Promise<void>((resolveReady) => {
    options.registerShutdownTrigger = (trigger: () => void) => {
      handler = trigger;
      resolveReady();
    };
  });
  return { ready, shutdown: () => handler?.() };
}
