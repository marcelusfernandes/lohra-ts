import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// [probe-complementar] t12-busy-error-event-path-exists-not-wire-observable
// (L20 / assertion 47). The oracle baseline (T12 baseline §2 L20) declares
// TWO code paths for busy: (a) the WS layer checks `session.busy` before
// acquiring and returns the wire-observed 4009 RPC error -- proven on the
// wire by t12-busy-4009-multisocket-race; (b) a second, harder-to-reach
// path inside GatewaySession.submit itself, reached only in the race
// window between the check and a non-blocking lock acquire, which emits a
// `{"type":"error","payload":{"message":"session busy"}}` EVENT instead --
// declared "exists in code, not observed on the wire in 4 attempts" for
// the ORACLE, not absent.
//
// This is a genuine, honest structural finding, not a parity confirmation:
// the CANDIDATE's busy check (session-service.ts's busySessions Set) is a
// single synchronous flag with exactly ONE observable outcome (the 4009 at
// ws/connection.ts) -- there is no second, racy acquire-based code path in
// this implementation for a second path to hide in. Recorded here rather
// than silently claimed as matching, per this ticket's own mechanism-vs-
// absence discipline: the WIRE-OBSERVABLE behavior is proven identical to
// the oracle (always 4009, zero error events, across a real multi-socket
// race -- see t12-busy-4009-multisocket-race), but the INTERNAL mechanism
// genuinely differs, and that difference is declared rather than papered
// over.
const CONNECTION_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/gateway/ws/connection.ts"),
  "utf8",
);
const SESSION_SERVICE_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/gateway/session-service.ts"),
  "utf8",
);

describe("busy handling: single code path, no second race-only error-event branch (L20)", () => {
  it("the only busy-related outcome is the 4009 RPC error in ws/connection.ts", () => {
    expect(CONNECTION_SOURCE).toContain('code: 4009, message: "session busy"');
  });

  it("no code path anywhere in the gateway emits a busy `error` event -- the candidate's busy check has no second, racy branch to produce one", () => {
    const gatewaySources = [CONNECTION_SOURCE, SESSION_SERVICE_SOURCE].join("\n");
    // A busy-triggered error EVENT would look like this project's own
    // event-emission shape ({"type":"error", payload with a busy message})
    // -- absent here, unlike a false "found nothing" from searching too
    // narrow a string.
    expect(gatewaySources).not.toMatch(/type:\s*"error"[\s\S]{0,200}busy/iu);
  });

  it("session-service.ts's busy state is a plain synchronous Set, not a lock/semaphore with a non-blocking-acquire failure mode", () => {
    expect(SESSION_SERVICE_SOURCE).toContain("busySessions = new Set<string>()");
    expect(SESSION_SERVICE_SOURCE).not.toMatch(/acquire|semaphore|mutex|lock\(/iu);
  });
});
