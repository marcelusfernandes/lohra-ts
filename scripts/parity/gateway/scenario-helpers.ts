// Shared types and helpers for T12's [socket-bilateral] scenario modules.
// Extracted from run-scenarios.ts unchanged (same bodies, now exported) so
// new scenario files (scripts/parity/gateway/scenarios/*.ts) can reuse the
// same bilateral-comparison machinery the original 11 scenarios already
// use and the Evaluator has already audited, without duplicating it.
import type { FakeUpstream } from "./fake-upstream.js";
import { sendRawHttpRequest, type RawHttpResponse } from "./raw-http-client.js";
import { WS_OPCODE, type RawWsClient } from "./raw-ws-client.js";

// Pinned via LOHRA_DASHBOARD_SESSION_TOKEN on both the oracle and candidate
// (see launch-oracle.ts's/launch-candidate-fake.ts's dashboardToken option)
// by any phase that needs a KNOWN valid credential -- e.g. the OWS/
// duplicate-header matrix, which is meaningless against a garbage token
// (every whitespace variant would just 401 regardless, never touching the
// real trim/compare logic).
export const SECURE_PHASE_DASHBOARD_TOKEN = "t12-secure-phase-pinned-token-CCCC";

export interface ScenarioContext {
  readonly oraclePort: number;
  readonly candidatePort: number;
  readonly fakeUpstream: FakeUpstream;
  /** Set only when the phase pinned a KNOWN, identical dashboard token on
   * both the oracle and candidate (see launch-oracle.ts's/launch-
   * candidate-fake.ts's dashboardToken option) -- undefined in phases that
   * let each side mint its own random token. */
  readonly dashboardToken?: string;
}

export interface ScenarioResult {
  readonly id: string;
  readonly verdict: "match" | "divergent" | "error";
  readonly detail?: string;
  readonly evidence?: unknown;
}

export interface NamedScenario {
  readonly id: string;
  readonly run: (ctx: ScenarioContext) => Promise<ScenarioResult>;
}

export function jsonBody(response: RawHttpResponse): unknown {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return response.body.toString("utf8");
  }
}

export function headerValue(response: RawHttpResponse, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of response.headers) if (key.toLowerCase() === lower) return value;
  return null;
}

export function match(id: string, evidence: unknown): ScenarioResult {
  return { id, verdict: "match", evidence };
}

export function divergent(id: string, detail: string, evidence?: unknown): ScenarioResult {
  return { id, verdict: "divergent", detail, evidence };
}

export async function probeBoth(
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

export async function probeBothUpgrade(
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
export const MASKED_KEYS = new Set([
  "session_id",
  "id",
  "created_at",
  "started_at",
  "ended_at",
  "cwd",
  "parent_session_id",
]);

export function compareMasked(a: unknown, b: unknown, path = "$"): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b))
      return `${path}: array-shape mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`;
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

// Same masking rule as compareMasked, but producing a stable value instead
// of a divergence report: replaces every MASKED_KEYS field with a
// type-tagged placeholder (session ids, timestamps) and sorts object keys,
// so hashing the result is reproducible across runs even though the raw
// evidence contains fresh random ids and clock-dependent timestamps every
// time the scenarios execute.
export function normalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForDigest(item));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = MASKED_KEYS.has(key)
        ? `<masked:${typeof record[key]}>`
        : normalizeForDigest(record[key]);
    }
    return normalized;
  }
  return value;
}

export interface RpcRoundTripResult {
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
export async function nextRpcResultFrame(
  ws: RawWsClient,
  rpcId: number | string,
  maxSkip = 5,
): Promise<{
  readonly envelope: Record<string, unknown>;
  readonly skippedEvents: readonly unknown[];
}> {
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
  throw new Error(
    `NEXT_RPC_RESULT_FRAME_EXHAUSTED id=${String(rpcId)} skipped=${JSON.stringify(skippedEvents)}`,
  );
}

// Sends the SAME JSON-RPC request to both raw WS connections and does a
// masked structural+value comparison of the full response envelope
// (including `result`, not just its key set) -- a candidate returning a
// wrong-but-same-shaped payload is caught here, not just a wrong-shaped
// one.
export async function rpcRoundTrip(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  request: {
    readonly jsonrpc: "2.0";
    readonly id: number | string;
    readonly method: string;
    readonly params: unknown;
  },
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
export async function perSessionRoundTrip(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  rpcId: number,
  method: string,
  oracleSessionId: string,
  candidateSessionId: string,
  extraParams: Record<string, unknown> = {},
): Promise<RpcRoundTripResult> {
  oracleWs.sendText(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method,
      params: { session_id: oracleSessionId, ...extraParams },
    }),
  );
  candidateWs.sendText(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method,
      params: { session_id: candidateSessionId, ...extraParams },
    }),
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

export interface DrainedEvent {
  readonly kind: "event" | "rpc-result";
  readonly type?: string;
  readonly payload?: unknown;
}

export async function drainUntilComplete(
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

export function eventTypeSequence(events: readonly DrainedEvent[]): readonly string[] {
  return events.map((event) => (event.kind === "event" ? (event.type ?? "?") : "rpc-result"));
}

export function frameKey(envelope: {
  readonly method?: string;
  readonly id?: unknown;
  readonly params?: { readonly type?: string };
}): string {
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
export async function collectKeyedFrames(
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
    throw new Error(
      `COLLECT_KEYED_FRAMES_EXHAUSTED missing=${JSON.stringify([...required])} seen=${JSON.stringify(Object.keys(seen))}`,
    );
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
export async function waitForSilenceToleratingSessionInfo(
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

export interface CreatedSessionPair {
  readonly divergence: string | null;
  readonly evidence: unknown;
  readonly oracleSessionId: string;
  readonly candidateSessionId: string;
}

export async function createSessionBoth(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
): Promise<CreatedSessionPair> {
  const create = await rpcRoundTrip(oracleWs, candidateWs, {
    jsonrpc: "2.0",
    id: 1,
    method: "session.create",
    params: {},
  });
  return {
    divergence: create.divergence,
    evidence: create,
    oracleSessionId:
      (create.oracleEnvelope.result as { session_id: string } | undefined)?.session_id ?? "",
    candidateSessionId:
      (create.candidateEnvelope.result as { session_id: string } | undefined)?.session_id ?? "",
  };
}
