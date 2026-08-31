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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import {
  launchCandidateFakeUpstreamDashboard,
  type LaunchedGatewayProcess as LaunchedCandidateProcess,
} from "./launch-candidate-fake.js";
import { launchOracleDashboard, type LaunchedOracleProcess, verifyOracleGuard } from "./launch-oracle.js";
import { sendRawHttpRequest, type RawHttpResponse } from "./raw-http-client.js";
import { connectRawWs, decodeCloseFrame, WS_OPCODE, type RawWsClient } from "./raw-ws-client.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(projectRoot, ".parity-evidence/t12");
mkdirSync(evidenceRoot, { recursive: true });

interface ScenarioContext {
  readonly oraclePort: number;
  readonly candidatePort: number;
  readonly fakeUpstream: FakeUpstream;
}

interface ScenarioResult {
  readonly id: string;
  readonly verdict: "match" | "divergent" | "error";
  readonly detail?: string;
  readonly evidence?: unknown;
}

interface NamedScenario {
  readonly id: string;
  readonly run: (ctx: ScenarioContext) => Promise<ScenarioResult>;
}

function jsonBody(response: RawHttpResponse): unknown {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return response.body.toString("utf8");
  }
}

function headerValue(response: RawHttpResponse, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of response.headers) if (key.toLowerCase() === lower) return value;
  return null;
}

function match(id: string, evidence: unknown): ScenarioResult {
  return { id, verdict: "match", evidence };
}

function divergent(id: string, detail: string, evidence?: unknown): ScenarioResult {
  return { id, verdict: "divergent", detail, evidence };
}

async function probeBoth(
  ctx: ScenarioContext,
  path: string,
  headers: readonly (readonly [string, string])[],
  method = "GET",
): Promise<{ readonly oracle: RawHttpResponse; readonly candidate: RawHttpResponse }> {
  const [oracle, candidate] = await Promise.all([
    sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
      method,
      path,
      headers: [...headers, ["Host", "127.0.0.1"], ["Connection", "close"]],
    }),
    sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
      method,
      path,
      headers: [...headers, ["Host", "127.0.0.1"], ["Connection", "close"]],
    }),
  ]);
  return { oracle, candidate };
}

async function probeBothUpgrade(
  ctx: ScenarioContext,
  path: string,
): Promise<{ readonly oracleStatus: number; readonly candidateStatus: number }> {
  const headers: readonly (readonly [string, string])[] = [
    ["Host", "127.0.0.1"],
    ["Connection", "Upgrade"],
    ["Upgrade", "websocket"],
    ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
    ["Sec-WebSocket-Version", "13"],
  ];
  const [oracle, candidate] = await Promise.all([
    sendRawHttpRequest("127.0.0.1", ctx.oraclePort, { method: "GET", path, headers }),
    sendRawHttpRequest("127.0.0.1", ctx.candidatePort, { method: "GET", path, headers }),
  ]);
  return { oracleStatus: oracle.status, candidateStatus: candidate.status };
}

// Recursively compares two values, treating a small set of known
// instance-specific field names (session ids, timestamps, cwd) as
// type-only checks rather than exact-value ones. Everything else -- key
// sets, array lengths, primitive values -- must match exactly. Returns
// null when equal, or a path-qualified description of the first
// divergence found.
const MASKED_KEYS = new Set(["session_id", "id", "created_at", "started_at", "ended_at", "cwd", "parent_session_id"]);

function compareMasked(a: unknown, b: unknown, path = "$"): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array-shape mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
    if (a.length !== b.length) return `${path}: length ${String(a.length)} vs ${String(b.length)}`;
    for (let i = 0; i < a.length; i += 1) {
      const sub = compareMasked(a[i], b[i], `${path}[${String(i)}]`);
      if (sub !== null) return sub;
    }
    return null;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const recordA = a as Record<string, unknown>;
    const recordB = b as Record<string, unknown>;
    const aKeys = Object.keys(recordA).sort();
    const bKeys = Object.keys(recordB).sort();
    if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
      return `${path}: keys ${JSON.stringify(aKeys)} vs ${JSON.stringify(bKeys)}`;
    }
    for (const key of aKeys) {
      if (MASKED_KEYS.has(key)) {
        if (typeof recordA[key] !== typeof recordB[key]) {
          return `${path}.${key}: type ${typeof recordA[key]} vs ${typeof recordB[key]}`;
        }
        continue;
      }
      const sub = compareMasked(recordA[key], recordB[key], `${path}.${key}`);
      if (sub !== null) return sub;
    }
    return null;
  }
  if (a !== b) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  return null;
}

interface RpcRoundTripResult {
  readonly divergence: string | null;
  readonly oracleEnvelope: Record<string, unknown>;
  readonly candidateEnvelope: Record<string, unknown>;
}

// session.info is broadcast asynchronously, not strictly synchronous with
// session.create -- it can arrive interleaved with an unrelated RPC's own
// response depending on timing. Reading "the next frame" blindly after
// sending an RPC request sometimes catches that stray event instead of
// the actual result, desynchronizing whatever comes after. This drains
// (and records) any event frames first, returning only the frame carrying
// the given RPC id.
async function nextRpcResultFrame(
  ws: RawWsClient,
  rpcId: number,
  maxSkip = 5,
): Promise<{ readonly envelope: Record<string, unknown>; readonly skippedEvents: readonly unknown[] }> {
  const skippedEvents: unknown[] = [];
  for (let i = 0; i < maxSkip; i += 1) {
    const frame = await ws.nextFrame();
    const envelope = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
    if (envelope.method === "event") {
      skippedEvents.push(envelope);
      continue;
    }
    if (envelope.id === rpcId) return { envelope, skippedEvents };
    // A response for a different id -- keep it as evidence but keep
    // waiting for the one this call actually asked for.
    skippedEvents.push(envelope);
  }
  throw new Error(`NEXT_RPC_RESULT_FRAME_EXHAUSTED id=${String(rpcId)} skipped=${JSON.stringify(skippedEvents)}`);
}

// Sends the SAME JSON-RPC request to both raw WS connections and does a
// masked structural+value comparison of the full response envelope
// (including `result`, not just its key set) -- a candidate returning a
// wrong-but-same-shaped payload is caught here, not just a wrong-shaped
// one.
async function rpcRoundTrip(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  request: { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params: unknown },
): Promise<RpcRoundTripResult> {
  oracleWs.sendText(JSON.stringify(request));
  candidateWs.sendText(JSON.stringify(request));
  const [oracleResult, candidateResult] = await Promise.all([
    nextRpcResultFrame(oracleWs, request.id),
    nextRpcResultFrame(candidateWs, request.id),
  ]);
  return {
    divergence: compareMasked(oracleResult.envelope, candidateResult.envelope),
    oracleEnvelope: oracleResult.envelope,
    candidateEnvelope: candidateResult.envelope,
  };
}

// Same as rpcRoundTrip, but for methods keyed on a session_id -- each side
// gets a request built from ITS OWN session id (they're independently
// random per process), not one shared literal request. rpcRoundTrip alone
// would send the oracle's session_id to the candidate's socket too,
// which is simply the wrong request there.
async function perSessionRoundTrip(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  rpcId: number,
  method: string,
  oracleSessionId: string,
  candidateSessionId: string,
  extraParams: Record<string, unknown> = {},
): Promise<RpcRoundTripResult> {
  oracleWs.sendText(
    JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: { session_id: oracleSessionId, ...extraParams } }),
  );
  candidateWs.sendText(
    JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: { session_id: candidateSessionId, ...extraParams } }),
  );
  const [oracleResult, candidateResult] = await Promise.all([
    nextRpcResultFrame(oracleWs, rpcId),
    nextRpcResultFrame(candidateWs, rpcId),
  ]);
  return {
    divergence: compareMasked(oracleResult.envelope, candidateResult.envelope),
    oracleEnvelope: oracleResult.envelope,
    candidateEnvelope: candidateResult.envelope,
  };
}

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

interface DrainedEvent {
  readonly kind: "event" | "rpc-result";
  readonly type?: string;
  readonly payload?: unknown;
}

async function drainUntilComplete(
  ws: RawWsClient,
  maxFrames = 12,
  frameTimeoutMs = 10_000,
): Promise<DrainedEvent[]> {
  const drained: DrainedEvent[] = [];
  for (let i = 0; i < maxFrames; i += 1) {
    const frame = await ws.nextFrame(frameTimeoutMs);
    if (frame.opcode !== WS_OPCODE.text) continue;
    const envelope = JSON.parse(frame.payload.toString("utf8")) as {
      readonly method?: string;
      readonly params?: { readonly type: string; readonly payload: unknown };
      readonly result?: unknown;
    };
    if (envelope.method === "event" && envelope.params !== undefined) {
      drained.push({ kind: "event", type: envelope.params.type, payload: envelope.params.payload });
      if (envelope.params.type === "message.complete") break;
    } else {
      drained.push({ kind: "rpc-result", payload: envelope.result });
    }
  }
  return drained;
}

function eventTypeSequence(events: readonly DrainedEvent[]): readonly string[] {
  return events.map((event) => (event.kind === "event" ? (event.type ?? "?") : "rpc-result"));
}

function frameKey(envelope: { readonly method?: string; readonly id?: unknown; readonly params?: { readonly type?: string } }): string {
  if (envelope.method === "event") return `event:${envelope.params?.type ?? "?"}`;
  return `rpc:${String(envelope.id)}`;
}

// Reads frames one at a time until every key in `requiredKeys` has been
// seen, keyed by identity (rpc:<id> or event:<type>) rather than
// positionally -- session.info is broadcast asynchronously and can land
// before, between, or after the frames a specific RPC call actually
// produces, so a fixed read-order assumption is not reliable here. Any
// EXTRA frame seen along the way (e.g. session.info itself) is kept in
// the returned map too, so nothing is silently dropped.
async function collectKeyedFrames(
  ws: RawWsClient,
  requiredKeys: readonly string[],
  maxFrames = 5,
  frameTimeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const seen: Record<string, unknown> = {};
  const required = new Set(requiredKeys);
  for (let i = 0; i < maxFrames && required.size > 0; i += 1) {
    const frame = await ws.nextFrame(frameTimeoutMs);
    const envelope = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
    const key = frameKey(envelope);
    seen[key] = envelope;
    required.delete(key);
  }
  if (required.size > 0) {
    throw new Error(`COLLECT_KEYED_FRAMES_EXHAUSTED missing=${JSON.stringify([...required])} seen=${JSON.stringify(Object.keys(seen))}`);
  }
  return seen;
}

// "Permanent silence" (ADR-T12-02) means this specific request never gets
// a completion -- it does NOT mean the socket goes silent for every
// purpose. session.info can legitimately arrive during the silence
// window (it's an independent broadcast, unrelated to the ghost
// request); tolerate and absorb it, but any OTHER frame is a genuine
// violation. Returns null on true silence, or the offending frame's
// parsed envelope if something else arrived.
async function waitForSilenceToleratingSessionInfo(
  ws: RawWsClient,
  budgetMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let frame;
    try {
      frame = await ws.nextFrame(remaining);
    } catch {
      return null;
    }
    const envelope = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
    if (frameKey(envelope) === "event:session.info") continue;
    return envelope;
  }
}

interface CreatedSessionPair {
  readonly divergence: string | null;
  readonly evidence: unknown;
  readonly oracleSessionId: string;
  readonly candidateSessionId: string;
}

async function createSessionBoth(oracleWs: RawWsClient, candidateWs: RawWsClient): Promise<CreatedSessionPair> {
  const create = await rpcRoundTrip(oracleWs, candidateWs, {
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: {},
  });
  return {
    divergence: create.divergence,
    evidence: create,
    oracleSessionId: (create.oracleEnvelope.result as { session_id: string } | undefined)?.session_id ?? "",
    candidateSessionId: (create.candidateEnvelope.result as { session_id: string } | undefined)?.session_id ?? "",
  };
}

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
): Promise<ScenarioResult[]> {
  let oracle: LaunchedOracleProcess | undefined;
  let candidate: LaunchedCandidateProcess | undefined;
  const results: ScenarioResult[] = [];
  try {
    const home = mkdtempSync(join(tmpdir(), `lohra-t12-candidate-home-${label}-`));
    [oracle, candidate] = await Promise.all([
      launchOracleDashboard({ fakeUpstreamPort: fakeUpstream.port, insecure }),
      launchCandidateFakeUpstreamDashboard({
        fakeUpstreamPort: fakeUpstream.port,
        home,
        insecure,
        bootTimeoutMs: 20_000,
      }),
    ]);
    const ctx: ScenarioContext = { oraclePort: oracle.port, candidatePort: candidate.port, fakeUpstream };
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
    const secureResults = await runPhase("secure", SECURE_SCENARIOS, false, fakeUpstream);
    const insecureResults = await runPhase(
      "insecure",
      [...INSECURE_SCENARIOS, ...TURN_SCENARIOS],
      true,
      fakeUpstream,
    );
    results = [...secureResults, ...insecureResults];
  } finally {
    await fakeUpstream.close();
  }

  const evidencePath = join(evidenceRoot, "run-scenarios.json");
  writeFileSync(evidencePath, JSON.stringify({ results }, null, 2));

  const failed = results.filter((result) => result.verdict !== "match");
  for (const result of results) {
    const marker = result.verdict === "match" ? "PASS" : "FAIL";
    console.log(`[${marker}] ${result.id}${result.detail !== undefined ? ` -- ${result.detail}` : ""}`);
  }
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} scenarios match.`);
  console.log(`Evidence: ${evidencePath}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
