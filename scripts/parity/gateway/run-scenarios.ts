#!/usr/bin/env node
// The T12 [socket-bilateral] scenario runner: launches the real oracle and
// the real candidate side by side, on ephemeral ports, and probes BOTH
// with nothing but the raw HTTP/RFC6455 clients built in this ticket --
// no ws library, no TestClient, no in-process shortcuts. This is the
// Evaluator-facing evidence class assertion 67 requires as principal
// proof; everything under tests/gateway/ is this session's own TDD
// confidence, not a substitute for this.
//
// Verdict policy: the PRIMARY signal for every scenario is bilateral
// equality -- oracle's own observed result is ground truth, and the
// candidate must match it on the facts the scenario reads. A handful of
// scenarios additionally assert a literal expected value (e.g. the 4401
// close code, a binding contract decision this session implemented
// directly) as defense-in-depth against both sides coincidentally
// drifting the same wrong way; that check never substitutes for the
// bilateral one. Every result carries the observed evidence, not just a
// pass/fail label, so an auditor doesn't have to trust the verdict alone.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import {
  launchCandidateFakeUpstreamDashboard,
  type LaunchedGatewayProcess as LaunchedCandidateProcess,
} from "./launch-candidate-fake.js";
import { launchOracleDashboard, type LaunchedOracleProcess, verifyOracleGuard } from "./launch-oracle.js";
import { sendRawHttpRequest } from "./raw-http-client.js";
import { connectRawWs, decodeCloseFrame, WS_OPCODE } from "./raw-ws-client.js";
import {
  compareMasked,
  createSessionBoth,
  divergent,
  drainUntilComplete,
  eventTypeSequence,
  headerValue,
  jsonBody,
  match,
  normalizeForDigest,
  perSessionRoundTrip,
  probeBoth,
  probeBothUpgrade,
  rpcRoundTrip,
  waitForSilenceToleratingSessionInfo,
  collectKeyedFrames,
  SECURE_PHASE_DASHBOARD_TOKEN,
  type NamedScenario,
  type ScenarioContext,
  type ScenarioResult,
} from "./scenario-helpers.js";
import { AUTH_HEADER_MATRIX_SCENARIOS } from "./scenarios/t12-auth-header-envelope-and-duplicate-matrix.js";
import { BUSY_4009_MULTISOCKET_SCENARIOS } from "./scenarios/t12-busy-4009-multisocket-race.js";
import { BINARY_FRAME_SCENARIOS } from "./scenarios/t12-ws-binary-frame-kills-socket.js";
import { DUAL_SERIALIZATION_SCENARIOS } from "./scenarios/t12-tool-frame-dual-serialization-nonascii.js";
import { PERSISTED_SHAPES_SCENARIOS } from "./scenarios/t12-persisted-message-shapes-and-rest-equals-ws.js";
import { RCE_DENY_SCENARIOS } from "./scenarios/t12-tool-terminal-rce-proof-and-dangerous-deny.js";
import { REST_25_SWEEP_SCENARIOS } from "./scenarios/t12-rest-route-negative-sweep-25-routes.js";
import { RPC_FRAMING_EDGES_SCENARIOS } from "./scenarios/t12-rpc-framing-edges-33-probes.js";
import { UPSTREAM_ERROR_WARNING_SCENARIOS } from "./scenarios/t12-upstream-error-warning-field-no-error-event.js";
import { WS_QUERY_AND_HEADER_TOKEN_SCENARIOS } from "./scenarios/t12-ws-query-multiplicity-and-header-token.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".parity-evidence/t12");
mkdirSync(evidenceRoot, { recursive: true });

// -- [socket-bilateral] scenarios, secure mode (auth enforced) -------------

const SECURE_SCENARIOS: NamedScenario[] = [
  // t12-surface-exact-routes-and-openapi-schema (assertion 13, 17)
  {
    id: "t12-surface-exact-routes-and-openapi-schema",
    run: async (ctx) => {
      const id = "t12-surface-exact-routes-and-openapi-schema";
      const { oracle, candidate } = await probeBoth(ctx, "/openapi.json", []);
      if (oracle.status !== candidate.status) {
        return divergent(id, `status oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
      }
      if (oracle.status !== 200) return divergent(id, `expected 200, both sides got ${String(oracle.status)}`);
      const oraclePaths = Object.keys((jsonBody(oracle) as { paths: Record<string, unknown> }).paths).sort();
      const candidatePaths = Object.keys(
        (jsonBody(candidate) as { paths: Record<string, unknown> }).paths,
      ).sort();
      if (JSON.stringify(oraclePaths) !== JSON.stringify(candidatePaths)) {
        return divergent(
          id,
          `paths oracle=${JSON.stringify(oraclePaths)} candidate=${JSON.stringify(candidatePaths)}`,
          { oraclePaths, candidatePaths },
        );
      }
      return match(id, { status: oracle.status, pathCount: oraclePaths.length, paths: oraclePaths });
    },
  },

  // t12-auth-order-precedes-routing (assertion 14/L1): no token, unknown path
  {
    id: "t12-auth-order-precedes-routing",
    run: async (ctx) => {
      const id = "t12-auth-order-precedes-routing";
      const { oracle, candidate } = await probeBoth(ctx, "/api/does-not-exist", []);
      if (oracle.status !== candidate.status) {
        return divergent(id, `no-token oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
      }
      if (oracle.status !== 401) return divergent(id, `expected 401, both sides got ${String(oracle.status)}`);
      return match(id, { status: oracle.status, body: jsonBody(oracle) });
    },
  },

  // t12-docs-open-and-no-spa (assertion 17/L11): docs bypasses auth, root 404s
  {
    id: "t12-docs-open-and-no-spa",
    run: async (ctx) => {
      const id = "t12-docs-open-and-no-spa";
      const root = await probeBoth(ctx, "/", []);
      if (root.oracle.status !== root.candidate.status) {
        return divergent(id, `root oracle=${String(root.oracle.status)} candidate=${String(root.candidate.status)}`);
      }
      const docs = await probeBoth(ctx, "/docs", []);
      if (docs.oracle.status !== docs.candidate.status) {
        return divergent(id, `docs oracle=${String(docs.oracle.status)} candidate=${String(docs.candidate.status)}`);
      }
      if (docs.oracle.status !== 200) {
        return divergent(id, `expected docs=200, both sides got ${String(docs.oracle.status)}`);
      }
      return match(id, { rootStatus: root.oracle.status, docsStatus: docs.oracle.status });
    },
  },

  // t12-options-head-enumeration (assertion 16/L12): pure bilateral, no
  // hard-coded expectation -- the exact interaction between auth-ordering
  // and OPTIONS/HEAD semantics is read off the oracle itself, not assumed.
  {
    id: "t12-options-head-enumeration",
    run: async (ctx) => {
      const id = "t12-options-head-enumeration";
      const knownOptions = await probeBoth(ctx, "/api/status", [], "OPTIONS");
      if (knownOptions.oracle.status !== knownOptions.candidate.status) {
        return divergent(
          id,
          `OPTIONS /api/status oracle=${String(knownOptions.oracle.status)} candidate=${String(knownOptions.candidate.status)}`,
        );
      }
      const unknownOptions = await probeBoth(ctx, "/api/does-not-exist", [], "OPTIONS");
      if (unknownOptions.oracle.status !== unknownOptions.candidate.status) {
        return divergent(
          id,
          `OPTIONS unknown oracle=${String(unknownOptions.oracle.status)} candidate=${String(unknownOptions.candidate.status)}`,
        );
      }
      return match(id, {
        optionsKnownStatus: knownOptions.oracle.status,
        optionsUnknownStatus: unknownOptions.oracle.status,
      });
    },
  },

  // t12-location-host-header-derivation-and-arbitrary-host (L23): bilateral
  // on whatever Location the oracle actually derives from an attacker-
  // controlled Host header.
  {
    id: "t12-location-host-header-derivation-and-arbitrary-host",
    run: async (ctx) => {
      const id = "t12-location-host-header-derivation-and-arbitrary-host";
      const [oracle, candidate] = await Promise.all([
        sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
          method: "GET",
          path: "/docs/",
          headers: [["Host", "evil.example:8080"], ["Connection", "close"]],
        }),
        sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
          method: "GET",
          path: "/docs/",
          headers: [["Host", "evil.example:8080"], ["Connection", "close"]],
        }),
      ]);
      if (oracle.status !== candidate.status) {
        return divergent(id, `status oracle=${String(oracle.status)} candidate=${String(candidate.status)}`);
      }
      const oracleLocation = headerValue(oracle, "location");
      const candidateLocation = headerValue(candidate, "location");
      if (oracleLocation !== candidateLocation) {
        return divergent(id, `location oracle=${String(oracleLocation)} candidate=${String(candidateLocation)}`);
      }
      return match(id, { status: oracle.status, location: oracleLocation });
    },
  },

  // t12-ws-handshake-always-101-then-close-4401 (assertion 19, binding
  // decision): the ONLY scenario where a literal expected value (4401,
  // empty reason) is asserted with confidence, since both sides implement
  // this exact binding decision -- oracle as the T12 baseline behavior,
  // candidate as this session's own product code.
  {
    id: "t12-ws-handshake-always-101-then-close-4401",
    run: async (ctx) => {
      const id = "t12-ws-handshake-always-101-then-close-4401";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      if (oracleWs.handshake.status !== candidateWs.handshake.status) {
        return divergent(
          id,
          `handshake oracle=${String(oracleWs.handshake.status)} candidate=${String(candidateWs.handshake.status)}`,
        );
      }
      if (oracleWs.handshake.status !== 101) {
        return divergent(id, `expected handshake=101, both sides got ${String(oracleWs.handshake.status)}`);
      }
      const [oracleFrame, candidateFrame] = await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]);
      oracleWs.close();
      candidateWs.close();
      if (oracleFrame.opcode !== candidateFrame.opcode) {
        return divergent(id, `opcode oracle=${String(oracleFrame.opcode)} candidate=${String(candidateFrame.opcode)}`);
      }
      if (oracleFrame.opcode !== WS_OPCODE.close) {
        return divergent(id, `expected a close frame, both sides sent opcode ${String(oracleFrame.opcode)}`);
      }
      const oracleClose = decodeCloseFrame(oracleFrame.payload);
      const candidateClose = decodeCloseFrame(candidateFrame.payload);
      if (oracleClose.code !== candidateClose.code || oracleClose.reason !== candidateClose.reason) {
        return divergent(
          id,
          `close oracle=${String(oracleClose.code)}/${oracleClose.reason} candidate=${String(candidateClose.code)}/${candidateClose.reason}`,
        );
      }
      if (oracleClose.code !== 4401 || oracleClose.reason !== "") {
        return divergent(id, `expected close=4401/"", both sides sent ${String(oracleClose.code)}/${oracleClose.reason}`);
      }
      return match(id, { handshakeStatus: oracleWs.handshake.status, closeCode: oracleClose.code, closeReason: oracleClose.reason });
    },
  },

  // t12-ws-path-sweep-unauthenticated (assertion 23/L3): bilateral across a
  // sweep of near-miss WS paths, no hard-coded status since the exact code
  // (403 vs 404 vs 401) per near-miss path is the oracle's own fact.
  {
    id: "t12-ws-path-sweep-unauthenticated",
    run: async (ctx) => {
      const id = "t12-ws-path-sweep-unauthenticated";
      const paths = ["/api/websocket", "/api/ws/", "/api/pty", "/api/pub", "/api/events"];
      const results = await Promise.all(paths.map(async (path) => [path, await probeBothUpgrade(ctx, path)] as const));
      for (const [path, result] of results) {
        if (result.oracleStatus !== result.candidateStatus) {
          return divergent(id, `${path}: oracle=${String(result.oracleStatus)} candidate=${String(result.candidateStatus)}`);
        }
      }
      return match(
        id,
        Object.fromEntries(results.map(([path, result]) => [path, result.oracleStatus])),
      );
    },
  },
];

// -- [socket-bilateral] scenarios, insecure mode (auth bypassed) -----------
// `--insecure` is the only way this harness has, today, to reach RPC
// methods without first minting and threading a valid session token
// through the raw client -- so these scenarios trade auth coverage (fully
// exercised above) for RPC-body coverage.

const INSECURE_SCENARIOS: NamedScenario[] = [
  // t12-rpc-session-lifecycle (assertion 27-32 subset): session.create,
  // session.list over a real RFC6455 connection, bilateral on the full
  // JSON-RPC response envelope INCLUDING `result` (masked only on the
  // handful of genuinely instance-specific fields), not just its shape.
  {
    id: "t12-rpc-session-lifecycle",
    run: async (ctx) => {
      const id = "t12-rpc-session-lifecycle";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        if (oracleWs.handshake.status !== 101 || candidateWs.handshake.status !== 101) {
          return divergent(
            id,
            `handshake oracle=${String(oracleWs.handshake.status)} candidate=${String(candidateWs.handshake.status)}`,
          );
        }
        // Drain the gateway.ready event both sides send right after connect.
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]);

        const create = await rpcRoundTrip(oracleWs, candidateWs, {
          jsonrpc: "2.0",
          id: 1,
          method: "session.create",
          params: {},
        });
        if (create.divergence !== null) {
          return divergent(id, `session.create: ${create.divergence}`, create);
        }

        const list = await rpcRoundTrip(oracleWs, candidateWs, {
          jsonrpc: "2.0",
          id: 2,
          method: "session.list",
          params: {},
        });
        if (list.divergence !== null) {
          return divergent(id, `session.list: ${list.divergence}`, list);
        }

        return match(id, { create: create.oracleEnvelope, list: list.oracleEnvelope });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];

// -- [socket-bilateral] scenarios, turn-execution (real prompt.submit) -----
// These need a real model call to complete, so both sides are launched
// wired to the loopback fake upstream (oracle via oracle-dash-launcher.py,
// candidate via candidate-dash-launcher.ts + the product's own
// registerProvider()) rather than a real provider.

const TURN_SCENARIOS: NamedScenario[] = [
  // t12-prompt-submit-basic-turn (assertions 27-32/44-47 subset): a full
  // real turn -- session.create, prompt.submit, streamed deltas, and
  // message.complete -- driven through both real processes against the
  // SAME canned fake-upstream response, bilateral on the emitted event
  // TYPE sequence and on message.complete's payload shape/value.
  {
    id: "t12-prompt-submit-basic-turn",
    run: async (ctx) => {
      const id = "t12-prompt-submit-basic-turn";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const create = await rpcRoundTrip(oracleWs, candidateWs, {
          jsonrpc: "2.0",
          id: 1,
          method: "session.create",
          params: {},
        });
        if (create.divergence !== null) return divergent(id, `session.create: ${create.divergence}`, create);
        const oracleSessionId = (create.oracleEnvelope.result as { session_id: string }).session_id;
        const candidateSessionId = (create.candidateEnvelope.result as { session_id: string }).session_id;

        oracleWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "prompt.submit",
            params: { session_id: oracleSessionId, text: "hello fake" },
          }),
        );
        candidateWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "prompt.submit",
            params: { session_id: candidateSessionId, text: "hello fake" },
          }),
        );

        const [oracleEvents, candidateEvents] = await Promise.all([
          drainUntilComplete(oracleWs),
          drainUntilComplete(candidateWs),
        ]);

        const oracleSequence = eventTypeSequence(oracleEvents);
        const candidateSequence = eventTypeSequence(candidateEvents);
        if (JSON.stringify(oracleSequence) !== JSON.stringify(candidateSequence)) {
          return divergent(
            id,
            `event sequence oracle=${JSON.stringify(oracleSequence)} candidate=${JSON.stringify(candidateSequence)}`,
            { oracleEvents, candidateEvents },
          );
        }

        const oracleComplete = oracleEvents.find((event) => event.type === "message.complete");
        const candidateComplete = candidateEvents.find((event) => event.type === "message.complete");
        const completeDivergence = compareMasked(oracleComplete?.payload, candidateComplete?.payload);
        if (completeDivergence !== null) {
          return divergent(id, `message.complete payload: ${completeDivergence}`, { oracleComplete, candidateComplete });
        }

        return match(id, { eventSequence: oracleSequence, messageComplete: oracleComplete?.payload });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },

  // t12-idle-interrupt-latch-zero-upstream-calls (assertion 44/L16): a
  // session.interrupt on an IDLE session (no turn in flight) latches, and
  // the next prompt.submit consumes that latch instead of ever reaching
  // the model -- zero upstream calls, "interrupted" status, empty text.
  {
    id: "t12-idle-interrupt-latch-zero-upstream-calls",
    run: async (ctx) => {
      const id = "t12-idle-interrupt-latch-zero-upstream-calls";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const created = await createSessionBoth(oracleWs, candidateWs);
        if (created.divergence !== null) return divergent(id, `session.create: ${created.divergence}`, created.evidence);

        const interrupt = await perSessionRoundTrip(
          oracleWs,
          candidateWs,
          2,
          "session.interrupt",
          created.oracleSessionId,
          created.candidateSessionId,
        );
        if (interrupt.divergence !== null) return divergent(id, `session.interrupt: ${interrupt.divergence}`, interrupt);

        const requestsBefore = ctx.fakeUpstream.requests().length;

        oracleWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "prompt.submit",
            params: { session_id: created.oracleSessionId, text: "should never reach upstream" },
          }),
        );
        candidateWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "prompt.submit",
            params: { session_id: created.candidateSessionId, text: "should never reach upstream" },
          }),
        );

        const [oracleEvents, candidateEvents] = await Promise.all([
          drainUntilComplete(oracleWs),
          drainUntilComplete(candidateWs),
        ]);
        const requestsAfter = ctx.fakeUpstream.requests().length;

        const oracleSequence = eventTypeSequence(oracleEvents);
        const candidateSequence = eventTypeSequence(candidateEvents);
        if (JSON.stringify(oracleSequence) !== JSON.stringify(candidateSequence)) {
          return divergent(
            id,
            `event sequence oracle=${JSON.stringify(oracleSequence)} candidate=${JSON.stringify(candidateSequence)}`,
            { oracleEvents, candidateEvents },
          );
        }
        const oracleComplete = oracleEvents.find((event) => event.type === "message.complete");
        const candidateComplete = candidateEvents.find((event) => event.type === "message.complete");
        const completeDivergence = compareMasked(oracleComplete?.payload, candidateComplete?.payload);
        if (completeDivergence !== null) {
          return divergent(id, `message.complete payload: ${completeDivergence}`, { oracleComplete, candidateComplete });
        }
        if (requestsAfter !== requestsBefore) {
          return divergent(
            id,
            `expected zero upstream calls, saw ${String(requestsAfter - requestsBefore)}`,
            { requestsBefore, requestsAfter },
          );
        }

        return match(id, { eventSequence: oracleSequence, messageComplete: oracleComplete?.payload, upstreamCallDelta: 0 });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },

  // t12-ghost-turn-permanent-silence-then-lock-released (assertion
  // 48/ADR-T12-02): prompt.submit with a non-string `text` triggers the
  // ghost turn -- rpc-ok + message.start, then PERMANENT silence on this
  // socket for this request (no message.complete, no error, no close).
  // The session lock still releases: a normal follow-up prompt.submit on
  // the SAME session must complete normally afterward.
  {
    id: "t12-ghost-turn-permanent-silence-then-lock-released",
    run: async (ctx) => {
      const id = "t12-ghost-turn-permanent-silence-then-lock-released";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const created = await createSessionBoth(oracleWs, candidateWs);
        if (created.divergence !== null) return divergent(id, `session.create: ${created.divergence}`, created.evidence);

        oracleWs.sendText(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: created.oracleSessionId, text: 42 } }),
        );
        candidateWs.sendText(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: created.candidateSessionId, text: 42 } }),
        );

        // session.info races asynchronously with the rpc-ack/message.start
        // pair (see nextRpcResultFrame's comment) -- reading exactly 2
        // frames positionally is not reliable here. Collect by identity
        // instead: whichever order rpc:2 and event:message.start arrive
        // in (absorbing session.info if it happens to land in between),
        // then compare the keyed maps.
        const [oracleAckSet, candidateAckSet] = await Promise.all([
          collectKeyedFrames(oracleWs, ["rpc:2", "event:message.start"]),
          collectKeyedFrames(candidateWs, ["rpc:2", "event:message.start"]),
        ]);
        const ackSetDivergence = compareMasked(oracleAckSet, candidateAckSet);
        if (ackSetDivergence !== null) return divergent(id, `rpc-ack/message.start: ${ackSetDivergence}`, { oracleAckSet, candidateAckSet });

        // Confirm permanent silence: a bounded wait, tolerating a
        // late-arriving session.info (an unrelated broadcast), must find
        // nothing else on BOTH sides -- anything else (message.complete,
        // an error, a close) would mean the ghost turn actually responded.
        const [oracleSilence, candidateSilence] = await Promise.all([
          waitForSilenceToleratingSessionInfo(oracleWs, 1500),
          waitForSilenceToleratingSessionInfo(candidateWs, 1500),
        ]);
        if (oracleSilence !== null || candidateSilence !== null) {
          return divergent(id, `expected silence, oracle=${oracleSilence === null ? "silent" : "spoke"} candidate=${candidateSilence === null ? "silent" : "spoke"}`, {
            oracle: oracleSilence,
            candidate: candidateSilence,
          });
        }

        // Prove the lock released: a normal follow-up prompt.submit on the
        // SAME session must complete normally.
        oracleWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "prompt.submit",
            params: { session_id: created.oracleSessionId, text: "hello fake" },
          }),
        );
        candidateWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "prompt.submit",
            params: { session_id: created.candidateSessionId, text: "hello fake" },
          }),
        );
        const [oracleEvents, candidateEvents] = await Promise.all([
          drainUntilComplete(oracleWs),
          drainUntilComplete(candidateWs),
        ]);
        const oracleSequence = eventTypeSequence(oracleEvents);
        const candidateSequence = eventTypeSequence(candidateEvents);
        if (JSON.stringify(oracleSequence) !== JSON.stringify(candidateSequence)) {
          return divergent(
            id,
            `follow-up event sequence oracle=${JSON.stringify(oracleSequence)} candidate=${JSON.stringify(candidateSequence)}`,
            { oracleEvents, candidateEvents },
          );
        }
        const oracleComplete = oracleEvents.find((event) => event.type === "message.complete");
        const candidateComplete = candidateEvents.find((event) => event.type === "message.complete");
        const completeDivergence = compareMasked(oracleComplete?.payload, candidateComplete?.payload);
        if (completeDivergence !== null) {
          return divergent(id, `follow-up message.complete: ${completeDivergence}`, { oracleComplete, candidateComplete });
        }

        return match(id, { followUpEventSequence: oracleSequence, followUpComplete: oracleComplete?.payload });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];

// Both sides always launch against the SAME loopback fake upstream
// (fakeprov), including the auth-enforced phase where no RPC ever fires --
// there is no scenario-relevant reason to boot the candidate against a
// real "anthropic" profile, and doing so once here silently made a
// session.info comparison fail on the model name (fake-model-a vs
// claude-opus-4-8): a harness artifact, not a genuine product divergence.
// One launch mechanism for every phase removes that whole class of bug.
async function runPhase(
  label: string,
  scenarios: readonly NamedScenario[],
  insecure: boolean,
  fakeUpstream: FakeUpstream,
  dashboardToken?: string,
): Promise<ScenarioResult[]> {
  let oracle: LaunchedOracleProcess | undefined;
  let candidate: LaunchedCandidateProcess | undefined;
  const results: ScenarioResult[] = [];
  try {
    const home = mkdtempSync(join(tmpdir(), `lohra-t12-candidate-home-${label}-`));
    const tokenOverride = dashboardToken === undefined ? {} : { dashboardToken };
    [oracle, candidate] = await Promise.all([
      launchOracleDashboard({ fakeUpstreamPort: fakeUpstream.port, insecure, ...tokenOverride }),
      launchCandidateFakeUpstreamDashboard({
        fakeUpstreamPort: fakeUpstream.port,
        home,
        insecure,
        bootTimeoutMs: 20_000,
        ...tokenOverride,
      }),
    ]);
    const ctx: ScenarioContext = { oraclePort: oracle.port, candidatePort: candidate.port, fakeUpstream, ...tokenOverride };
    for (const scenario of scenarios) {
      try {
        results.push(await scenario.run(ctx));
      } catch (error) {
        results.push({
          id: scenario.id,
          verdict: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await oracle?.kill();
    await candidate?.kill();
  }
  return results;
}

async function main(): Promise<void> {
  const guard = verifyOracleGuard();
  if (!guard.ok) {
    console.error(`ORACLE_GUARD_FAILED:${guard.detail}`);
    process.exitCode = 2;
    return;
  }

  const fakeUpstream: FakeUpstream = await startFakeUpstream();
  let results: ScenarioResult[];
  try {
    const secureResults = await runPhase(
      "secure",
      [
        ...SECURE_SCENARIOS,
        ...AUTH_HEADER_MATRIX_SCENARIOS,
        ...WS_QUERY_AND_HEADER_TOKEN_SCENARIOS,
        ...REST_25_SWEEP_SCENARIOS,
      ],
      false,
      fakeUpstream,
      SECURE_PHASE_DASHBOARD_TOKEN,
    );
    const insecureResults = await runPhase(
      "insecure",
      [
        ...INSECURE_SCENARIOS,
        ...TURN_SCENARIOS,
        ...RPC_FRAMING_EDGES_SCENARIOS,
        ...BINARY_FRAME_SCENARIOS,
        ...DUAL_SERIALIZATION_SCENARIOS,
        ...PERSISTED_SHAPES_SCENARIOS,
        ...BUSY_4009_MULTISOCKET_SCENARIOS,
        ...UPSTREAM_ERROR_WARNING_SCENARIOS,
        ...RCE_DENY_SCENARIOS,
      ],
      true,
      fakeUpstream,
    );
    results = [...secureResults, ...insecureResults];
  } finally {
    await fakeUpstream.close();
  }

  // Per-scenario projection hash mirrors T11's own run-process.ts pattern
  // (projectionSha256, then a suite digest over sorted "id=sha" lines) --
  // needed because the raw evidence is not byte-hashable as-is (session
  // ids and timestamps differ every run); normalizeForDigest masks exactly
  // the fields compareMasked already treats as type-only, so two runs of
  // an unchanged candidate/oracle pair produce an identical suite digest.
  const projections = results.map((result) => {
    const sha = createHash("sha256")
      .update(
        JSON.stringify({
          verdict: result.verdict,
          detail: result.detail,
          evidence: normalizeForDigest(result.evidence),
        }),
      )
      .digest("hex");
    return { id: result.id, sha };
  });
  const digest = createHash("sha256")
    .update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join(""))
    .digest("hex");

  const evidencePath = join(evidenceRoot, "run-scenarios.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({ suite: "t12-gateway-dashboard-socket-bilateral", digest, projections, results }, null, 2),
  );

  const failed = results.filter((result) => result.verdict !== "match");
  for (const result of results) {
    const marker = result.verdict === "match" ? "PASS" : "FAIL";
    console.log(`[${marker}] ${result.id}${result.detail !== undefined ? ` -- ${result.detail}` : ""}`);
  }
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios match.`);
  console.log(`Digest: ${digest}`);
  console.log(`Evidence: ${evidencePath}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
