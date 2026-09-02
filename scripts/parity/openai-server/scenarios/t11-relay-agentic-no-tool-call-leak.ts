// Assertion 42: in BOTH relay (no --tools) and agentic (--tools read_file)
// mode, tool calls are entirely server-side — no frame reaching the client
// ever contains `delta.tool_calls` or `finish_reason:"tool_calls"`. In
// agentic mode the loop dispatches read_file server-side and completes
// cleanly (the client sees only textual deltas and a normal finish).
//
// The relay half is genuinely adversarial: the fake upstream returns
// tool_calls even though the client never declared any (a hallucinating/
// misbehaving provider), which no dispatcher is configured to execute. The
// two real processes are MEASURED to disagree here, and that disagreement
// is a pre-existing, APPROVED characterized divergence from T08, not a T11
// finding to fix: `scripts/parity/conversation/generate-manifests.mjs`
// (~253, id "chat-complete-tool-hardening") pins `expectedDivergent: true`
// with candidate `exit: 1`/oracle `exit: 0` and the exact candidate stdout
// string "provider returned tool_calls while tools are disabled" (~519);
// `tests/conversation-runtime.test.ts` locks the same throw
// (UnexpectedToolCallError) at the unit level. Assertion 73 forbids
// re-baselining T08 fixtures to make T11 pass, so this scenario PINS the
// divergence per side (proving it stays exactly this shape, not just
// "different") instead of asserting bilateral bytes. What assertion 42
// actually requires — no raw tool_calls JSON artifact on the wire, on
// EITHER side — is still enforced.
//
// Registered twice in run-all.ts (relay + agentic config) — this file
// exports two thin entry points sharing one probe/analysis.
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

function postRequestLines(apiKey: string | null, body: string): string {
  return (
    "POST /v1/chat/completions HTTP/1.1\n" +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

// Structural leak only — an error frame's human-readable message is
// allowed to mention "tool_calls" in prose (e.g. "provider returned
// tool_calls while tools are disabled"); what assertion 42 forbids is the
// raw JSON artifact: a `delta.tool_calls` array or `finish_reason` literal
// "tool_calls".
function noToolCallLeak(body: string): boolean {
  return !/"tool_calls"\s*:\s*\[/u.test(body) && !/"finish_reason"\s*:\s*"tool_calls"/u.test(body);
}

function normalizeIds(body: string): string {
  return body.replaceAll(/"id":\s*"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\s*\d+/gu, '"created":0');
}

interface Result {
  readonly projection: unknown;
  readonly rawEvidence: unknown;
  readonly match: boolean;
  readonly differences: unknown[];
  readonly expectedUpstreamRequests: number;
}

/** Agentic (--tools read_file): the loop dispatches read_file server-side
 * and completes; 2 upstream calls per side (tool_calls, then final), and
 * both sides must agree byte-for-byte once ids/created are normalized. */
export async function runAgentic(oracle: ServerHandle, candidate: ServerHandle, upstream: FakeUpstream): Promise<Result> {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:toolcall-safe hi" }], stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("agentic-no-leak", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };
  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };
  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: normalizeIds(probe.oracle.body),
    candidateBody: normalizeIds(probe.candidate.body),
    extraDroppedHeaders: ["content-length"],
  });
  const checks = {
    statusOk: probe.oracle.statusLine.includes(" 200 ") && probe.candidate.statusLine.includes(" 200 "),
    oracleNoLeakOk: noToolCallLeak(probe.oracle.body),
    candidateNoLeakOk: noToolCallLeak(probe.candidate.body),
    bilateralOk: comparison.match,
    upstreamCountOk: probe.upstream.length === 4,
  };
  const ok = Object.values(checks).every(Boolean);
  const record = { id: "agentic-no-leak", checks, normalized: { oracle: comparison.oracle, candidate: comparison.candidate }, match: ok };
  return {
    projection: { probes: [record] },
    rawEvidence,
    match: ok,
    differences: ok ? [] : [record],
    expectedUpstreamRequests: 4,
  };
}

const RELAY_ORACLE_PIN =
  'data: {"id":"<ID>", "object": "chat.completion.chunk", "created":0, "model": "m", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}\n\n' +
  'data: {"id":"<ID>", "object": "chat.completion.chunk", "created":0, "model": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}\n\n' +
  "data: [DONE]\n\n";
const RELAY_CANDIDATE_PIN =
  'data: {"id":"<ID>", "object": "chat.completion.chunk", "created":0, "model": "m", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}\n\n' +
  'data: {"error": {"message": "provider returned tool_calls while tools are disabled", "type": "upstream_error"}}\n\n' +
  "data: [DONE]\n\n";

// Round-1 Evaluator finding (F2): the streaming relay pin above only
// covers `stream:true`. The SAME "unsolicited upstream tool_calls, no
// dispatcher" condition on a NON-stream request diverges in a way the
// streaming pin never surfaces: the oracle still completes normally
// (200, empty content, finish "stop", full usage) since loop.py's
// dispatch guard is the same regardless of stream mode, but the
// candidate's CompletionService maps UnexpectedToolCallError to a 502
// upstream_error (not an in-stream error frame, since there is no stream
// to be mid-way through) — a STATUS-LEVEL divergence the streaming-only
// scenario never declared. Pinned per side for the same T08-authority
// reason as the streaming half.
function normalizeCompactIds(body: string): string {
  return body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0');
}

/** Relay (no --tools), non-stream: the unsolicited-tool_calls divergence
 * is a STATUS-level split here (oracle 200, candidate 502), not just a
 * body split — F2's declared gap. */
export async function runRelayNonStream(oracle: ServerHandle, candidate: ServerHandle, upstream: FakeUpstream): Promise<Result> {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:toolcall-safe hi" }] });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("relay-no-leak-nonstream", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };
  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };
  const oracleNormalized = normalizeCompactIds(probe.oracle.body);
  const candidateNormalized = normalizeCompactIds(probe.candidate.body);
  const checks = {
    // The status-level split IS the finding — declared explicitly, not
    // hidden behind a generic "both 2xx" style check.
    oracleStatus200Ok: probe.oracle.statusLine.includes(" 200 "),
    candidateStatus502Ok: probe.candidate.statusLine.includes(" 502 "),
    oracleNoLeakOk: noToolCallLeak(probe.oracle.body),
    candidateNoLeakOk: noToolCallLeak(probe.candidate.body),
    oraclePinnedOk: oracleNormalized === '{"id":"<ID>","object":"chat.completion","created":0,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}',
    candidatePinnedOk: candidateNormalized === '{"error":{"message":"provider returned tool_calls while tools are disabled","type":"upstream_error"}}',
    upstreamCountOk: probe.upstream.length === 2,
  };
  const ok = Object.values(checks).every(Boolean);
  const record = {
    id: "relay-no-leak-nonstream",
    checks,
    note: "F2: status-level (200 vs 502) characterized divergence for the same T08-approved unsolicited-tool_calls condition as relay-no-leak's streaming half, declared explicitly per side.",
    normalized: { oracle: oracleNormalized, candidate: candidateNormalized },
    match: ok,
  };
  return {
    projection: { probes: [record] },
    rawEvidence,
    match: ok,
    differences: ok ? [] : [record],
    expectedUpstreamRequests: 2,
  };
}

/** Relay (no --tools): no dispatcher exists. The oracle's loop.py falls
 * through its `finish_reason == "tool_calls" and agent.tool_dispatch`
 * guard (dispatch is falsy) straight to the terminal branch and completes
 * normally with empty content; the candidate raises UnexpectedToolCallError
 * — an approved T08 hardening divergence, pinned per side below rather
 * than asserted bilaterally. */
export async function runRelay(oracle: ServerHandle, candidate: ServerHandle, upstream: FakeUpstream): Promise<Result> {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:toolcall-safe hi" }], stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("relay-no-leak", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };
  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };
  const oracleNormalized = normalizeIds(probe.oracle.body);
  const candidateNormalized = normalizeIds(probe.candidate.body);
  const checks = {
    statusOk: probe.oracle.statusLine.includes(" 200 ") && probe.candidate.statusLine.includes(" 200 "),
    oracleNoLeakOk: noToolCallLeak(probe.oracle.body),
    candidateNoLeakOk: noToolCallLeak(probe.candidate.body),
    oraclePinnedOk: oracleNormalized === RELAY_ORACLE_PIN,
    candidatePinnedOk: candidateNormalized === RELAY_CANDIDATE_PIN,
    upstreamCountOk: probe.upstream.length === 2,
  };
  const ok = Object.values(checks).every(Boolean);
  const record = {
    id: "relay-no-leak",
    checks,
    note: "expected characterized divergence per T08 chat-complete-tool-hardening (assertion 73 forbids re-baselining); pinned per side, not bilateral.",
    normalized: { oracle: oracleNormalized, candidate: candidateNormalized },
    match: ok,
  };
  return {
    projection: { probes: [record] },
    rawEvidence,
    match: ok,
    differences: ok ? [] : [record],
    expectedUpstreamRequests: 2,
  };
}
